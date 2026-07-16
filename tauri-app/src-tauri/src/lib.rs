use std::{
    env, fs,
    ffi::{OsStr, OsString},
    io::{self, Read, Write},
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};

use tauri::{Manager, WindowEvent};

#[cfg(unix)]
use std::os::unix::process::CommandExt;

const SERVER_PORT: u16 = 49_321;
const SERVER_START_TIMEOUT: Duration = Duration::from_secs(60);
const HTTP_TIMEOUT: Duration = Duration::from_millis(500);
const REPOSITORY_ENV: &str = "ULTRADYN_DOCS_REPOSITORY";
const REPOSITORY_FLAG: &str = "--repository";
const REPOSITORY_MARKER: &str = ".ultradyn/manifest.json";
const REPOSITORY_PATH_FILE: &str = "repository-path.txt";
const NPM_CONFIG_FILE: &str = "npmrc-ultradyn";
const NPM_GLOBAL_CONFIG_FILE: &str = "npmrc-ultradyn-global";
const NPM_REGISTRY: &str = "https://registry.npmjs.org/";
const NPM_PACKAGE_SPEC: &str = concat!("@ultradyn/docs@", env!("CARGO_PKG_VERSION"));
const LOCAL_PACKAGE_SPEC_ENV: &str = "ULTRADYN_DOCS_LOCAL_PACKAGE";
const LAUNCH_NONCE_ENV: &str = "ULTRADYN_DOCS_LAUNCH_NONCE";
const LAUNCH_NONCE_HEADER: &str = "X-Ultradyn-Launch-Nonce";

struct ServerProcess(Mutex<Option<Child>>);

struct StartedServer {
    child: Child,
    launcher_nonce: String,
}

impl Drop for ServerProcess {
    fn drop(&mut self) {
        if let Ok(process) = self.0.get_mut() {
            if let Some(child) = process.as_mut() {
                terminate_server(child);
            }
            *process = None;
        }
    }
}

fn server_address() -> SocketAddr {
    SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), SERVER_PORT)
}

fn explicit_repository_path() -> io::Result<Option<PathBuf>> {
    let arguments: Vec<OsString> = env::args_os().skip(1).collect();
    let mut selected = None;
    let mut index = 0;
    while index < arguments.len() {
        if arguments[index] == REPOSITORY_FLAG {
            let value = arguments.get(index + 1).ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidInput,
                    format!("{REPOSITORY_FLAG} requires a path"),
                )
            })?;
            if selected.replace(PathBuf::from(value)).is_some() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    format!("{REPOSITORY_FLAG} may only be supplied once"),
                ));
            }
            index += 2;
            continue;
        }

        if let Some(value) = arguments[index]
            .to_str()
            .and_then(|argument| argument.strip_prefix("--repository="))
        {
            if value.is_empty() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    format!("{REPOSITORY_FLAG} requires a path"),
                ));
            }
            if selected.replace(PathBuf::from(value)).is_some() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    format!("{REPOSITORY_FLAG} may only be supplied once"),
                ));
            }
        }
        index += 1;
    }

    if selected.is_some() {
        return Ok(selected);
    }

    Ok(env::var_os(REPOSITORY_ENV)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from))
}

fn validate_repository_path(repository: &Path) -> io::Result<PathBuf> {
    let canonical = repository.canonicalize().map_err(|error| {
        io::Error::new(
            error.kind(),
            format!(
                "could not open Ultradyn Docs repository {}: {error}",
                repository.display()
            ),
        )
    })?;
    if !canonical.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("repository path is not a directory: {}", canonical.display()),
        ));
    }
    if !canonical.join(REPOSITORY_MARKER).is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "{} is not an initialized Ultradyn Docs repository (missing {REPOSITORY_MARKER})",
                canonical.display()
            ),
        ));
    }
    if canonical.to_str().is_none() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "the desktop shell currently requires a UTF-8 repository path",
        ));
    }
    Ok(canonical)
}

fn persist_repository_path(config_directory: &Path, repository: &Path) -> io::Result<()> {
    fs::create_dir_all(config_directory)?;
    let destination = config_directory.join(REPOSITORY_PATH_FILE);
    let temporary = config_directory.join(format!(
        ".{REPOSITORY_PATH_FILE}.{}.tmp",
        std::process::id()
    ));
    fs::write(&temporary, format!("{}\n", repository.display()))?;

    #[cfg(target_os = "windows")]
    if destination.exists() {
        fs::remove_file(&destination)?;
    }

    fs::rename(temporary, destination)
}

fn resolve_repository_path(
    config_directory: &Path,
    explicit: Option<PathBuf>,
) -> io::Result<PathBuf> {
    if let Some(repository) = explicit {
        let repository = validate_repository_path(&repository)?;
        persist_repository_path(config_directory, &repository)?;
        return Ok(repository);
    }

    let persisted_path = config_directory.join(REPOSITORY_PATH_FILE);
    let persisted = fs::read_to_string(&persisted_path).map_err(|error| {
        let message = if error.kind() == io::ErrorKind::NotFound {
            format!(
                "select an initialized repository with {REPOSITORY_FLAG} <path> or {REPOSITORY_ENV}; no saved selection exists at {}",
                persisted_path.display()
            )
        } else {
            format!(
                "could not read saved repository selection {}: {error}",
                persisted_path.display()
            )
        };
        io::Error::new(error.kind(), message)
    })?;
    let persisted = persisted
        .strip_suffix("\r\n")
        .or_else(|| persisted.strip_suffix('\n'))
        .unwrap_or(&persisted);
    if persisted.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("saved repository selection is empty: {}", persisted_path.display()),
        ));
    }
    validate_repository_path(Path::new(persisted))
}

fn port_is_open() -> bool {
    TcpStream::connect_timeout(&server_address(), Duration::from_millis(150)).is_ok()
}

fn http_get(path: &str, launcher_nonce: Option<&str>) -> io::Result<String> {
    let mut stream = TcpStream::connect_timeout(&server_address(), HTTP_TIMEOUT)?;
    stream.set_read_timeout(Some(HTTP_TIMEOUT))?;
    stream.set_write_timeout(Some(HTTP_TIMEOUT))?;
    write!(
        stream,
        "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{SERVER_PORT}\r\nAccept: application/json\r\n"
    )?;
    if let Some(nonce) = launcher_nonce {
        write!(stream, "{LAUNCH_NONCE_HEADER}: {nonce}\r\n")?;
    }
    write!(stream, "Connection: close\r\n\r\n")?;
    stream.flush()?;

    let mut response = String::new();
    stream.take(64 * 1024).read_to_string(&mut response)?;
    Ok(response)
}

fn response_json(response: &str) -> Option<serde_json::Value> {
    let (headers, body) = response.split_once("\r\n\r\n")?;
    let status = headers.lines().next()?.split_whitespace().nth(1)?;
    if status != "200" {
        return None;
    }
    serde_json::from_str(body).ok()
}

fn health_response_is_compatible(response: &str) -> bool {
    let Some(body) = response_json(response) else {
        return false;
    };
    body.get("status").and_then(|value| value.as_str()) == Some("ok")
        && body.get("version").and_then(|value| value.as_str())
            == Some(env!("CARGO_PKG_VERSION"))
}

fn runtime_response_matches_repository(response: &str, repository: &Path) -> bool {
    let Some(body) = response_json(response) else {
        return false;
    };
    body.get("repoRoot")
        .and_then(|value| value.as_str())
        .map(Path::new)
        == Some(repository)
}

fn server_matches_repository(repository: &Path) -> bool {
    http_get("/api/health", None)
        .map(|response| health_response_is_compatible(&response))
        .unwrap_or(false)
        && http_get("/api/runtime", None)
            .map(|response| runtime_response_matches_repository(&response, repository))
            .unwrap_or(false)
}

fn desktop_readiness_response_is_compatible(response: &str) -> bool {
    let Some(body) = response_json(response) else {
        return false;
    };
    body.get("status").and_then(|value| value.as_str()) == Some("ok")
}

fn server_is_ready(repository: &Path, launcher_nonce: &str) -> bool {
    server_matches_repository(repository)
        && http_get("/api/desktop-readiness", Some(launcher_nonce))
            .map(|response| desktop_readiness_response_is_compatible(&response))
            .unwrap_or(false)
}

fn create_launcher_nonce() -> io::Result<String> {
    let mut bytes = [0_u8; 32];
    getrandom::getrandom(&mut bytes)
        .map_err(|error| io::Error::other(format!("could not generate launcher nonce: {error}")))?;
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut nonce = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        nonce.push(HEX[usize::from(byte >> 4)] as char);
        nonce.push(HEX[usize::from(byte & 0x0f)] as char);
    }
    Ok(nonce)
}

#[cfg(target_os = "windows")]
fn npx_program() -> &'static str {
    "npx.cmd"
}

#[cfg(not(target_os = "windows"))]
fn npx_program() -> &'static str {
    "npx"
}

/// Starts only a loopback-bound command. The selected repository is validated
/// by the desktop shell and passed as a single process argument. Any occupied
/// port is rejected so this process never depends on another owner's child.
fn controlled_npm_config(config_directory: &Path) -> io::Result<PathBuf> {
    fs::create_dir_all(config_directory)?;
    let path = config_directory.join(NPM_CONFIG_FILE);
    let contents = format!("registry={NPM_REGISTRY}\nignore-scripts=true\n");
    fs::write(&path, &contents)?;
    fs::write(config_directory.join(NPM_GLOBAL_CONFIG_FILE), contents)?;
    Ok(path)
}

fn resolve_package_spec(local_package: Option<OsString>, debug_build: bool) -> OsString {
    if debug_build {
        if let Some(local_package) = local_package.filter(|value| !value.is_empty()) {
            return local_package;
        }
    }
    OsString::from(NPM_PACKAGE_SPEC)
}

fn server_command(
    repository: &Path,
    launcher_directory: &Path,
    npm_config: &Path,
    package_spec: &OsStr,
    launcher_nonce: &str,
) -> Command {
    let mut command = Command::new(npx_program());
    command
        .args(["--yes", "--ignore-scripts"])
        .arg(format!("--registry={NPM_REGISTRY}"))
        .arg("--package")
        .arg(package_spec)
        .args(["ultradyn-docs", "serve"])
        .arg(repository)
        .args(["--no-open", "--host", "127.0.0.1", "--port", "49321"])
        .current_dir(launcher_directory)
        .env("NPM_CONFIG_REGISTRY", NPM_REGISTRY)
        .env("NPM_CONFIG_IGNORE_SCRIPTS", "true")
        .env("NPM_CONFIG_USERCONFIG", npm_config)
        .env(
            "NPM_CONFIG_GLOBALCONFIG",
            launcher_directory.join(NPM_GLOBAL_CONFIG_FILE),
        )
        .env("ULTRADYN_DOCS_DESKTOP", "1")
        .env(LAUNCH_NONCE_ENV, launcher_nonce)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command
}

fn start_server(repository: &Path, launcher_directory: &Path) -> io::Result<StartedServer> {
    if port_is_open() {
        let detail = if server_matches_repository(repository) {
            "a compatible Ultradyn Docs server for this repository is already running; close it before launching the desktop app".to_owned()
        } else {
            format!(
                "the listener does not match Ultradyn Docs {} and repository {}",
                env!("CARGO_PKG_VERSION"),
                repository.display()
            )
        };
        return Err(io::Error::new(
            io::ErrorKind::AddrInUse,
            format!("port {SERVER_PORT} is occupied: {detail}"),
        ));
    }

    let npm_config = controlled_npm_config(launcher_directory)?;
    let launcher_nonce = create_launcher_nonce()?;
    let package_spec = resolve_package_spec(
        env::var_os(LOCAL_PACKAGE_SPEC_ENV),
        cfg!(debug_assertions),
    );
    let mut command = server_command(
        repository,
        launcher_directory,
        &npm_config,
        &package_spec,
        &launcher_nonce,
    );

    // Give the launcher and server their own process group so closing the app
    // cannot leave an orphaned npm/node descendant on Unix.
    #[cfg(unix)]
    command.process_group(0);

    let mut child = command.spawn().map_err(|error| {
        io::Error::new(
            error.kind(),
            format!(
                "could not start npx {}: {error}",
                package_spec.to_string_lossy()
            ),
        )
    })?;
    let deadline = Instant::now() + SERVER_START_TIMEOUT;
    loop {
        if let Some(status) = child.try_wait()? {
            // The npx leader can exit after starting a descendant. Clean the
            // process group on this path too, even though the leader is reaped.
            terminate_server(&mut child);
            return Err(io::Error::other(format!(
                "npx {NPM_PACKAGE_SPEC} exited before the server was ready ({status})"
            )));
        }
        if server_is_ready(repository, &launcher_nonce) {
            return Ok(StartedServer {
                child,
                launcher_nonce,
            });
        }
        if Instant::now() >= deadline {
            terminate_server(&mut child);
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                format!(
                    "npx {NPM_PACKAGE_SPEC} did not expose compatible health, runtime, and owned desktop readiness within {} seconds",
                    SERVER_START_TIMEOUT.as_secs()
                ),
            ));
        }
        thread::sleep(Duration::from_millis(100));
    }
}

fn terminate_server(child: &mut Child) {
    #[cfg(unix)]
    {
        let process_group = child.id() as i32;
        unsafe {
            // Negative PID targets the process group created above.
            let _ = libc::kill(-process_group, libc::SIGTERM);
        }
        let mut leader_reaped = false;
        for _ in 0..20 {
            if !leader_reaped && matches!(child.try_wait(), Ok(Some(_))) {
                leader_reaped = true;
            }
            if !process_group_is_alive(process_group) {
                if !leader_reaped {
                    let _ = child.wait();
                }
                return;
            }
            thread::sleep(Duration::from_millis(50));
        }
        unsafe {
            let _ = libc::kill(-process_group, libc::SIGKILL);
        }
        if !leader_reaped {
            let _ = child.wait();
        }
        for _ in 0..20 {
            if !process_group_is_alive(process_group) {
                break;
            }
            thread::sleep(Duration::from_millis(50));
        }
        return;
    }

    #[cfg(target_os = "windows")]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        let _ = child.wait();
        return;
    }

    #[cfg(not(any(unix, target_os = "windows")))]
    {
        let _ = child.kill();
        let _ = child.wait();
    }
}

#[cfg(unix)]
fn process_group_is_alive(process_group: i32) -> bool {
    if unsafe { libc::kill(-process_group, 0) } == 0 {
        return true;
    }
    io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let config_directory = app.path().app_config_dir()?;
            let repository = resolve_repository_path(
                &config_directory,
                explicit_repository_path()?,
            )?;
            let StartedServer {
                child,
                launcher_nonce,
            } = start_server(&repository, &config_directory)?;
            app.manage(ServerProcess(Mutex::new(Some(child))));
            let window = app.get_webview_window("main").ok_or_else(|| {
                io::Error::new(io::ErrorKind::NotFound, "the main desktop window was not created")
            })?;
            window.navigate(
                format!(
                    "http://127.0.0.1:{SERVER_PORT}/?ultradyn_desktop={launcher_nonce}"
                )
                .parse()?,
            )?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" && matches!(event, WindowEvent::Destroyed) {
                let state = window.app_handle().state::<ServerProcess>();
                if let Ok(mut guard) = state.0.lock() {
                    if let Some(child) = guard.as_mut() {
                        terminate_server(child);
                    }
                    *guard = None;
                };
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running the Ultradyn Docs desktop shell");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_directory(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock must be after the Unix epoch")
            .as_nanos();
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "ultradyn-docs-desktop-{label}-{}-{nonce}-{counter}",
            std::process::id()
        ))
    }

    fn initialized_repository(label: &str) -> PathBuf {
        let repository = temp_directory(label);
        fs::create_dir_all(repository.join(".ultradyn"))
            .expect("repository fixture directory should be created");
        fs::write(repository.join(REPOSITORY_MARKER), "{}\n")
            .expect("repository fixture marker should be written");
        repository
    }

    #[test]
    fn explicit_repository_is_validated_and_persisted() {
        let config = temp_directory("config-explicit");
        let repository = initialized_repository("repository-explicit");

        let resolved = resolve_repository_path(&config, Some(repository.clone()))
            .expect("an initialized repository should be accepted");

        assert_eq!(resolved, repository.canonicalize().unwrap());
        assert_eq!(
            fs::read_to_string(config.join(REPOSITORY_PATH_FILE)).unwrap(),
            format!("{}\n", resolved.display())
        );

        fs::remove_dir_all(config).unwrap();
        fs::remove_dir_all(repository).unwrap();
    }

    #[test]
    fn persisted_repository_is_reused() {
        let config = temp_directory("config-persisted");
        let repository = initialized_repository("repository-persisted");
        let first = resolve_repository_path(&config, Some(repository.clone())).unwrap();

        let second = resolve_repository_path(&config, None).unwrap();

        assert_eq!(second, first);
        fs::remove_dir_all(config).unwrap();
        fs::remove_dir_all(repository).unwrap();
    }

    #[test]
    fn repository_without_installer_marker_is_rejected() {
        let config = temp_directory("config-invalid");
        let repository = temp_directory("repository-invalid");
        fs::create_dir_all(&repository).unwrap();

        let error = resolve_repository_path(&config, Some(repository.clone())).unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
        assert!(error.to_string().contains(REPOSITORY_MARKER));
        assert!(!config.join(REPOSITORY_PATH_FILE).exists());
        fs::remove_dir_all(repository).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn persisted_repository_preserves_path_whitespace() {
        let config = temp_directory("config-whitespace");
        let parent = temp_directory("repository-whitespace");
        let repository = parent.join(" repository with edge spaces ");
        fs::create_dir_all(repository.join(".ultradyn")).unwrap();
        fs::write(repository.join(REPOSITORY_MARKER), "{}\n").unwrap();
        let expected = repository.canonicalize().unwrap();

        resolve_repository_path(&config, Some(repository)).unwrap();
        let restored = resolve_repository_path(&config, None).unwrap();

        assert_eq!(restored, expected);
        fs::remove_dir_all(config).unwrap();
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn desktop_npm_and_tauri_versions_stay_aligned() {
        let manifest_directory = Path::new(env!("CARGO_MANIFEST_DIR"));
        let npm: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(manifest_directory.join("../../package.json")).unwrap(),
        )
        .unwrap();
        let tauri: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(manifest_directory.join("tauri.conf.json")).unwrap(),
        )
        .unwrap();

        assert_eq!(
            npm.get("version").and_then(serde_json::Value::as_str),
            Some(env!("CARGO_PKG_VERSION"))
        );
        assert_eq!(
            tauri.get("version").and_then(serde_json::Value::as_str),
            Some(env!("CARGO_PKG_VERSION"))
        );
        assert_eq!(
            NPM_PACKAGE_SPEC,
            format!("@ultradyn/docs@{}", env!("CARGO_PKG_VERSION"))
        );
    }

    #[test]
    fn debug_launcher_can_run_an_unpublished_local_package() {
        let local_package = OsString::from("/tmp/ultradyn-docs-local");

        assert_eq!(
            resolve_package_spec(Some(local_package.clone()), true),
            local_package
        );
        assert_eq!(
            resolve_package_spec(Some(OsString::from("/tmp/untrusted-package")), false),
            OsString::from(NPM_PACKAGE_SPEC)
        );
    }

    #[test]
    fn launcher_ignores_repository_npm_configuration() {
        let repository = initialized_repository("repository-malicious-npmrc");
        fs::write(
            repository.join(".npmrc"),
            "@ultradyn:registry=https://attacker.invalid/\n",
        )
        .unwrap();
        let config = temp_directory("trusted-launcher-config");
        let npm_config = controlled_npm_config(&config).unwrap();
        let launcher_nonce = "a".repeat(64);
        let command = server_command(
            &repository,
            &config,
            &npm_config,
            OsStr::new(NPM_PACKAGE_SPEC),
            &launcher_nonce,
        );
        let arguments: Vec<String> = command
            .get_args()
            .map(|argument| argument.to_string_lossy().into_owned())
            .collect();

        assert_eq!(command.get_current_dir(), Some(config.as_path()));
        assert!(arguments.contains(&format!("--registry={NPM_REGISTRY}")));
        assert!(arguments.contains(&"--ignore-scripts".to_owned()));
        assert!(arguments.contains(&"--package".to_owned()));
        assert!(arguments.contains(&NPM_PACKAGE_SPEC.to_owned()));
        let configured_nonce = command
            .get_envs()
            .find(|(key, _)| *key == std::ffi::OsStr::new(LAUNCH_NONCE_ENV))
            .and_then(|(_, value)| value)
            .and_then(|value| value.to_str());
        assert_eq!(configured_nonce, Some(launcher_nonce.as_str()));
        assert_eq!(
            fs::read_to_string(npm_config).unwrap(),
            format!("registry={NPM_REGISTRY}\nignore-scripts=true\n")
        );
        assert_eq!(
            fs::read_to_string(config.join(NPM_GLOBAL_CONFIG_FILE)).unwrap(),
            format!("registry={NPM_REGISTRY}\nignore-scripts=true\n")
        );

        fs::remove_dir_all(config).unwrap();
        fs::remove_dir_all(repository).unwrap();
    }

    #[test]
    fn health_response_requires_ultradyn_identity_and_matching_version() {
        let matching = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{{\"status\":\"ok\",\"version\":\"{}\"}}",
            env!("CARGO_PKG_VERSION")
        );
        let wrong_version = "HTTP/1.1 200 OK\r\n\r\n{\"status\":\"ok\",\"version\":\"9.9.9\"}";
        let unrelated = "HTTP/1.1 200 OK\r\n\r\n{\"status\":\"ok\"}";

        assert!(health_response_is_compatible(&matching));
        assert!(!health_response_is_compatible(wrong_version));
        assert!(!health_response_is_compatible(unrelated));
    }

    #[test]
    fn launcher_nonce_is_random_and_header_safe() {
        let first = create_launcher_nonce().unwrap();
        let second = create_launcher_nonce().unwrap();

        assert_eq!(first.len(), 64);
        assert!(first.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert_ne!(first, second);
    }

    #[test]
    fn desktop_readiness_requires_an_ok_response() {
        assert!(desktop_readiness_response_is_compatible(
            "HTTP/1.1 200 OK\r\n\r\n{\"status\":\"ok\"}"
        ));
        assert!(!desktop_readiness_response_is_compatible(
            "HTTP/1.1 404 Not Found\r\n\r\n{\"status\":\"ok\"}"
        ));
    }

    #[test]
    fn runtime_response_must_match_the_selected_repository() {
        let repository = initialized_repository("repository-runtime")
            .canonicalize()
            .unwrap();
        let matching = format!(
            "HTTP/1.1 200 OK\r\n\r\n{}",
            serde_json::json!({ "repoRoot": repository }).to_string()
        );
        let other = "HTTP/1.1 200 OK\r\n\r\n{\"repoRoot\":\"/somewhere/else\"}";

        assert!(runtime_response_matches_repository(&matching, &repository));
        assert!(!runtime_response_matches_repository(other, &repository));
        fs::remove_dir_all(repository).unwrap();
    }
}
