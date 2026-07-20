import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleDashed,
  Cloud,
  Database,
  FlaskConical,
  KeyRound,
  Laptop,
  LockKeyhole,
  PlugZap,
  RotateCcw,
  Save,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  TestTube2,
  Unplug,
} from "lucide-react";
import { useMemo, useState } from "react";

import { useApi } from "../api-context.js";
import { filterSettings } from "../model.js";
import { useAsyncResource, useDocumentTitle } from "../hooks.js";
import type {
  ProviderConsentScope,
  ProviderStatus,
  SettingDefinition,
  SettingScope,
  SettingValue,
} from "../types.js";
import {
  Button,
  Card,
  ComboBox,
  EmptyState,
  ErrorState,
  InlineNotice,
  LoadingState,
  PageHeader,
  StatusPill,
} from "../components/ui.js";

type SettingsTab = "preferences" | "providers";

function consentScopeLabel(scope: ProviderConsentScope): string {
  if (scope === "model") return "Model use";
  if (scope === "transcription") return "Speech transcription";
  return "Git hosting";
}

function consentScopeActionLabel(scope: ProviderConsentScope): string {
  return scope === "git-host" ? "Git hosting" : scope;
}

export function SettingsPage() {
  useDocumentTitle("Settings");
  const { api, runtime, refreshRuntime, refreshActorIdentity, refreshTheme } =
    useApi();
  const [tab, setTab] = useState<SettingsTab>("preferences");
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<SettingScope | "all">("all");
  const [category, setCategory] = useState("all");
  const [draftValues, setDraftValues] =
    useState<Record<string, SettingValue>>();
  const [dirtyKeys, setDirtyKeys] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const [restartPending, setRestartPending] = useState(false);
  const [serverUrl, setServerUrl] = useState(
    () => api.url("") || window.location.origin,
  );
  const serverSettingsUrl = useMemo(() => {
    try {
      const target = new URL(serverUrl);
      if (target.protocol !== "http:" && target.protocol !== "https:")
        return undefined;
      if (target.username || target.password) return undefined;
      target.pathname = "/";
      target.search = "";
      target.searchParams.set("ultradyn_connect", "1");
      target.hash = "/settings";
      return target.toString();
    } catch {
      return undefined;
    }
  }, [serverUrl]);
  const resource = useAsyncResource(async () => {
    const [settings, schema, providers] = await Promise.all([
      api.settings(),
      api.settingSchema(),
      api.providers(),
    ]);
    return { settings, schema, providers };
  }, [api]);

  const definitions = useMemo(
    () =>
      resource.data?.schema.length
        ? resource.data.schema
        : (resource.data?.settings.definitions ?? []),
    [resource.data],
  );
  const values = draftValues ?? resource.data?.settings.values ?? {};
  const categories = useMemo(
    () =>
      [...new Set(definitions.map((definition) => definition.category))].sort(),
    [definitions],
  );
  const visibleSettings = useMemo(
    () => filterSettings(definitions, { query, scope, category }),
    [definitions, query, scope, category],
  );
  const grouped = useMemo(() => {
    const groups = new Map<string, SettingDefinition[]>();
    for (const definition of visibleSettings)
      groups.set(definition.category, [
        ...(groups.get(definition.category) ?? []),
        definition,
      ]);
    return groups;
  }, [visibleSettings]);
  const dirty = dirtyKeys.length > 0;

  function updateValue(key: string, value: SettingValue) {
    setSaved(false);
    setDirtyKeys((current) =>
      current.includes(key) ? current : [...current, key],
    );
    setDraftValues((current) => ({
      ...(current ?? resource.data?.settings.values ?? {}),
      [key]: value,
    }));
  }

  async function save() {
    if (!draftValues) return;
    const requiresRestart = definitions.some(
      (definition) =>
        definition.restartRequired && dirtyKeys.includes(definition.key),
    );
    setSaving(true);
    setSaveError(undefined);
    try {
      const changes = Object.fromEntries(
        dirtyKeys.flatMap((key) =>
          draftValues[key] === undefined ? [] : [[key, draftValues[key]]],
        ),
      ) as Record<string, SettingValue>;
      const scopes = Object.fromEntries(
        definitions.map((definition) => [definition.key, definition.scope]),
      );
      await api.settingsSave(changes, scopes);
      setDraftValues(undefined);
      setDirtyKeys([]);
      resource.reload();
      await refreshRuntime();
      if (dirtyKeys.includes("identity.actorHandle"))
        await refreshActorIdentity();
      if (dirtyKeys.includes("appearance.theme")) await refreshTheme();
      if (requiresRestart) setRestartPending(true);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 3_000);
    } catch (caught) {
      setSaveError(
        caught instanceof Error
          ? caught.message
          : "Settings could not be saved.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="settings-page">
      <PageHeader
        eyebrow="Portable behavior, private preferences"
        title="Settings"
        description="Repository settings travel through Git. Personal settings and consent stay on this machine. Secrets belong in neither."
        actions={
          dirty ? (
            <StatusPill tone="warning">Unsaved changes</StatusPill>
          ) : (
            <StatusPill tone="positive">Saved</StatusPill>
          )
        }
      />
      <section
        className="server-connection"
        aria-labelledby="server-connection-title"
      >
        <div>
          <h2 id="server-connection-title">Server connection</h2>
          <p>
            This page reconnects to the current server automatically. Change
            the URL only to connect to a different server.
          </p>
        </div>
        <label htmlFor="server-url">
          <span>Server URL</span>
          <input
            id="server-url"
            type="url"
            value={serverUrl}
            aria-invalid={!serverSettingsUrl}
            aria-describedby={
              serverSettingsUrl ? undefined : "server-url-error"
            }
            onChange={(event) => setServerUrl(event.target.value)}
            placeholder="http://127.0.0.1:5885"
          />
        </label>
        {serverSettingsUrl ? (
          <a className="button button-secondary" href={serverSettingsUrl}>
            Connect to different server
          </a>
        ) : (
          <button className="button button-secondary" disabled>
            Connect to different server
          </button>
        )}
        {!serverSettingsUrl ? (
          <p className="server-url-error" id="server-url-error">
            Enter an HTTP(S) server URL without credentials.
          </p>
        ) : null}
      </section>
      <div
        className="settings-tabs"
        role="tablist"
        aria-label="Settings sections"
      >
        <button
          role="tab"
          aria-selected={tab === "preferences"}
          className={tab === "preferences" ? "active" : ""}
          onClick={() => setTab("preferences")}
        >
          <SlidersHorizontal aria-hidden="true" size={17} /> Preferences
        </button>
        <button
          role="tab"
          aria-selected={tab === "providers"}
          className={tab === "providers" ? "active" : ""}
          onClick={() => setTab("providers")}
        >
          <PlugZap aria-hidden="true" size={17} /> Connections
        </button>
      </div>

      {resource.loading && !resource.data ? (
        <LoadingState label="Loading settings and provider contracts…" />
      ) : null}
      {resource.error ? (
        <ErrorState error={resource.error} retry={resource.reload} />
      ) : null}
      {resource.data && tab === "preferences" ? (
        <>
          <div className="settings-scope-guide">
            <div>
              <span className="scope-icon repo">
                <Database size={17} />
              </span>
              <p>
                <strong>Repository</strong>
                <small>Non-secret, reviewed, and shared through Git</small>
              </p>
            </div>
            <div>
              <span className="scope-icon personal">
                <Laptop size={17} />
              </span>
              <p>
                <strong>Personal</strong>
                <small>Machine-local, never committed</small>
              </p>
            </div>
            <div>
              <span className="scope-icon secure">
                <LockKeyhole size={17} />
              </span>
              <p>
                <strong>Secrets</strong>
                <small>Only opaque provider handles cross this boundary</small>
              </p>
            </div>
          </div>
          {restartPending ? (
            <div className="settings-restart-notice">
              <InlineNotice
                tone="warning"
                title="Restart Ultradyn Docs to apply this change"
              >
                <p>
                  The saved server setting will take effect after a restart.
                </p>
              </InlineNotice>
            </div>
          ) : null}
          <div className="settings-toolbar">
            <label className="search-field">
              <Search aria-hidden="true" size={17} />
              <span className="visually-hidden">Search settings</span>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search labels and descriptions"
              />
            </label>
            <div className="select-field">
              <ComboBox
                label="Setting scope"
                value={scope}
                options={[
                  { value: "all", label: "Both scopes" },
                  { value: "repo", label: "Repository" },
                  { value: "personal", label: "Personal" },
                ]}
                onChange={setScope}
              />
            </div>
            <div className="select-field">
              <ComboBox
                label="Setting category"
                value={category}
                options={[
                  { value: "all", label: "Every category" },
                  ...categories.map((item) => ({ value: item, label: item })),
                ]}
                onChange={setCategory}
              />
            </div>
          </div>
          {!visibleSettings.length ? (
            <EmptyState
              title="No settings match"
              description="Try a broader search or choose both scopes."
            />
          ) : null}
          <div className="settings-groups">
            {[...grouped.entries()].map(([group, items]) => (
              <section
                className="settings-group"
                key={group}
                aria-labelledby={`setting-group-${slug(group)}`}
              >
                <div className="settings-group-head">
                  <span>
                    <Settings2 aria-hidden="true" size={18} />
                  </span>
                  <div>
                    <h2 id={`setting-group-${slug(group)}`}>{group}</h2>
                    <p>{categoryDescription(group)}</p>
                  </div>
                </div>
                <div className="setting-list">
                  {items.map((definition) => (
                    <SettingControl
                      key={definition.key}
                      definition={definition}
                      value={values[definition.key] ?? definition.defaultValue}
                      onChange={(value) => updateValue(definition.key, value)}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
          <div
            className={`save-bar${dirty ? " visible" : ""}`}
            aria-hidden={!dirty}
          >
            <div>
              {saveError ? (
                <span className="save-error">
                  <AlertTriangle size={16} /> {saveError}
                </span>
              ) : saved ? (
                <span className="save-success">
                  <CheckCircle2 size={16} /> Settings saved
                </span>
              ) : (
                <span>
                  Review and save {dirtyKeys.length} setting
                  {dirtyKeys.length === 1 ? "" : "s"}
                </span>
              )}
            </div>
            <Button
              variant="quiet"
              onClick={() => {
                setDraftValues(undefined);
                setDirtyKeys([]);
                setSaveError(undefined);
              }}
              disabled={saving}
            >
              <RotateCcw size={16} /> Discard
            </Button>
            <Button onClick={() => void save()} disabled={saving}>
              {saving ? (
                <CircleDashed className="spin" size={16} />
              ) : (
                <Save size={16} />
              )}{" "}
              Save settings
            </Button>
          </div>
        </>
      ) : null}

      {resource.data && tab === "providers" ? (
        <ProviderSettings
          providers={resource.data.providers}
          demoMode={runtime.demoMode}
          reload={resource.reload}
        />
      ) : null}
    </div>
  );
}

function SettingControl({
  definition,
  value,
  onChange,
}: {
  definition: SettingDefinition;
  value: SettingValue;
  onChange: (value: SettingValue) => void;
}) {
  const id = `setting-${slug(definition.key)}`;
  const restartNoteId = `${id}-restart-required`;
  const describedBy = `${id}-description${
    definition.restartRequired ? ` ${restartNoteId}` : ""
  }`;
  const checked = value === true;
  return (
    <div className={`setting-row setting-${definition.type}`}>
      <div className="setting-copy">
        <div>
          <label htmlFor={id}>{definition.label}</label>
          <StatusPill tone={definition.scope === "repo" ? "info" : "neutral"}>
            {definition.scope === "repo" ? (
              <Database size={12} />
            ) : (
              <Laptop size={12} />
            )}{" "}
            {definition.scope === "repo" ? "Repository" : "Personal"}
          </StatusPill>
          {definition.restartRequired ? (
            <span
              id={restartNoteId}
              className="restart-required-badge"
              role="note"
              aria-label="This setting requires an Ultradyn Docs restart"
              title="Restart Ultradyn Docs after saving this setting"
            >
              <StatusPill tone="warning">
                <RotateCcw aria-hidden="true" size={12} /> Restart required
              </StatusPill>
            </span>
          ) : null}
        </div>
        <p id={`${id}-description`}>{definition.description}</p>
        <code>{definition.key}</code>
      </div>
      <div className="setting-control">
        {definition.type === "boolean" ? (
          <button
            id={id}
            type="button"
            className={`switch${checked ? " on" : ""}`}
            role="switch"
            aria-checked={checked}
            aria-describedby={describedBy}
            onClick={() => onChange(!checked)}
          >
            <span />
            <em>{checked ? "On" : "Off"}</em>
          </button>
        ) : null}
        {definition.type === "select" ? (
          <ComboBox
            id={id}
            label={definition.label}
            value={String(value)}
            describedBy={describedBy}
            options={definition.options ?? []}
            onChange={onChange}
          />
        ) : null}
        {definition.type === "string" ? (
          <input
            id={id}
            value={String(value)}
            {...(definition.key === "identity.actorHandle"
              ? {
                  maxLength: 96,
                  pattern: "[a-z0-9][a-z0-9._:-]*",
                  autoCapitalize: "none",
                  autoCorrect: "off",
                  spellCheck: false,
                }
              : {})}
            aria-describedby={describedBy}
            onChange={(event) => onChange(event.target.value)}
          />
        ) : null}
        {definition.type === "number" ? (
          <input
            id={id}
            type="number"
            value={Number(value)}
            aria-describedby={describedBy}
            onChange={(event) => onChange(event.target.valueAsNumber)}
          />
        ) : null}
        {definition.type === "multiselect" ? (
          <div id={id} className="multi-select" aria-describedby={describedBy}>
            {definition.options?.map((option) => {
              const selected =
                Array.isArray(value) && value.includes(option.value);
              return (
                <label key={option.value}>
                  <input
                    type="checkbox"
                    checked={selected}
                    onChange={() =>
                      onChange(
                        selected
                          ? (value as string[]).filter(
                              (item) => item !== option.value,
                            )
                          : [
                              ...(Array.isArray(value) ? value : []),
                              option.value,
                            ],
                      )
                    }
                  />
                  <span>
                    {selected ? <Check size={12} /> : null}
                    {option.label}
                  </span>
                </label>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ProviderSettings({
  providers,
  demoMode,
  reload,
}: {
  providers: ProviderStatus[];
  demoMode: boolean;
  reload: () => void;
}) {
  const { api } = useApi();
  const [expanded, setExpanded] = useState<string>();
  const [working, setWorking] = useState<string>();
  const [confirmedScopes, setConfirmedScopes] = useState<
    Record<string, boolean>
  >({});
  const [message, setMessage] = useState<{
    tone: "positive" | "danger";
    title: string;
    text: string;
  }>();

  async function action(
    provider: ProviderStatus,
    kind: "consent" | "connect" | "disconnect" | "test",
    consent?: { scope: ProviderConsentScope; granted: boolean },
  ) {
    const actionKey = `${provider.id}:${kind}${consent ? `:${consent.scope}` : ""}`;
    setWorking(actionKey);
    setMessage(undefined);
    try {
      const result = await api.providerAction(
        provider.id,
        kind,
        kind === "consent" ? consent : undefined,
      );
      const testResult =
        kind === "test" ? extractTestResult(result) : undefined;
      setMessage({
        tone: testResult?.ok === false ? "danger" : "positive",
        title:
          kind === "test"
            ? testResult?.ok === false
              ? "Provider test failed"
              : "Provider contract passed"
            : `${provider.label} updated`,
        text:
          kind === "consent"
            ? `${consentScopeLabel(consent!.scope)} consent was ${consent!.granted ? "granted" : "revoked"} machine-locally. Other scopes were not changed.`
            : kind === "test"
              ? (testResult?.message ?? "The provider returned no test detail.")
              : `The ${kind} action completed.`,
      });
      if (consent)
        setConfirmedScopes((current) => ({
          ...current,
          [`${provider.id}:${consent.scope}`]: false,
        }));
      reload();
    } catch (caught) {
      setMessage({
        tone: "danger",
        title: `${provider.label} could not ${kind}`,
        text: caught instanceof Error ? caught.message : "Try again.",
      });
    } finally {
      setWorking(undefined);
    }
  }

  return (
    <div className="providers-settings">
      <InlineNotice tone="info" title="Connection checks are consent-gated">
        <p>
          Ultradyn Docs will not even inspect a known credential file or probe a
          local provider until you approve the exact source. Installed-client
          delegation is preferred.
        </p>
      </InlineNotice>
      {message ? (
        <InlineNotice tone={message.tone} title={message.title}>
          <p>{message.text}</p>
        </InlineNotice>
      ) : null}
      <div className="provider-grid">
        {providers.map((provider) => {
          const isExpanded = expanded === provider.id;
          const activationRequired =
            provider.availability === "activation_required" ||
            provider.availability === "blocked";
          return (
            <Card
              className={`provider-card${isExpanded ? " expanded" : ""}`}
              key={provider.id}
            >
              <button
                className="provider-summary"
                type="button"
                aria-expanded={isExpanded}
                onClick={() => {
                  setExpanded(isExpanded ? undefined : provider.id);
                  setConfirmedScopes({});
                }}
              >
                <span className="provider-logo" aria-hidden="true">
                  {provider.kind === "stt" ? (
                    <Cloud size={21} />
                  ) : provider.kind === "git" ? (
                    <ShieldCheck size={21} />
                  ) : (
                    <PlugZap size={21} />
                  )}
                </span>
                <span className="provider-title">
                  <strong>{provider.label}</strong>
                  <small>{provider.kind.toLocaleUpperCase()}</small>
                </span>
                <span className="provider-badges">
                  {provider.fake || demoMode ? (
                    <StatusPill tone="info">
                      <FlaskConical size={12} /> Fake contract available
                    </StatusPill>
                  ) : null}
                  <StatusPill
                    tone={
                      provider.connection === "connected"
                        ? "positive"
                        : activationRequired
                          ? "warning"
                          : "neutral"
                    }
                  >
                    {provider.connection === "connected"
                      ? "Connected"
                      : activationRequired
                        ? "Activation required"
                        : "Not connected"}
                  </StatusPill>
                </span>
                <ChevronDown aria-hidden="true" size={18} />
              </button>
              {isExpanded ? (
                <div className="provider-detail">
                  <p>{provider.description}</p>
                  {provider.reason ? (
                    <div className="provider-reason">
                      <AlertTriangle aria-hidden="true" size={16} />
                      <span>{provider.reason}</span>
                    </div>
                  ) : null}
                  {provider.capabilities?.length ? (
                    <div className="capability-list">
                      {provider.capabilities.map((capability) => (
                        <span key={capability}>
                          <CheckCircle2 size={13} /> {capability}
                        </span>
                      ))}
                    </div>
                  ) : null}
                  {provider.consentScopes?.length ? (
                    <div className="consent-panel">
                      <div>
                        <KeyRound aria-hidden="true" size={18} />
                        <div>
                          <strong>Scoped credential consent</strong>
                          <p>
                            Grant only the capability this source needs. Each
                            decision is stored independently on this machine; no
                            token is imported or exposed.
                          </p>
                        </div>
                      </div>
                      <div className="consent-scope-list">
                        {provider.consentScopes.map((scopeStatus) => {
                          const scopeKey = `${provider.id}:${scopeStatus.scope}`;
                          const granted = scopeStatus.consent === "granted";
                          return (
                            <section className="consent-scope" key={scopeKey}>
                              <div className="consent-scope-heading">
                                <div>
                                  <strong>
                                    {consentScopeLabel(scopeStatus.scope)}
                                  </strong>
                                  <small>
                                    {granted
                                      ? "Granted for this source"
                                      : scopeStatus.consent === "revoked"
                                        ? "Revoked"
                                        : scopeStatus.consent === "denied"
                                          ? "Denied"
                                          : "Consent required"}
                                  </small>
                                </div>
                                {granted ? (
                                  <Button
                                    variant="quiet"
                                    disabled={Boolean(working)}
                                    onClick={() =>
                                      void action(provider, "consent", {
                                        scope: scopeStatus.scope,
                                        granted: false,
                                      })
                                    }
                                  >
                                    <Unplug size={15} /> Revoke{" "}
                                    {consentScopeActionLabel(scopeStatus.scope)}
                                    {" consent"}
                                  </Button>
                                ) : null}
                              </div>
                              {!granted ? (
                                <>
                                  <label className="consent-check">
                                    <input
                                      type="checkbox"
                                      checked={
                                        confirmedScopes[scopeKey] === true
                                      }
                                      onChange={(event) =>
                                        setConfirmedScopes((current) => ({
                                          ...current,
                                          [scopeKey]: event.target.checked,
                                        }))
                                      }
                                    />
                                    <span>
                                      I authorize{" "}
                                      {consentScopeLabel(
                                        scopeStatus.scope,
                                      ).toLocaleLowerCase()}{" "}
                                      for this source and understand Ultradyn
                                      Docs may inspect whether that capability
                                      is available.
                                    </span>
                                  </label>
                                  <Button
                                    disabled={
                                      confirmedScopes[scopeKey] !== true ||
                                      Boolean(working)
                                    }
                                    onClick={() =>
                                      void action(provider, "consent", {
                                        scope: scopeStatus.scope,
                                        granted: true,
                                      })
                                    }
                                  >
                                    <ShieldCheck size={16} /> Grant{" "}
                                    {consentScopeActionLabel(scopeStatus.scope)}
                                    {" consent"}
                                  </Button>
                                </>
                              ) : null}
                            </section>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}
                  {provider.activationChecklist?.length ? (
                    <div className="activation-checklist">
                      <h3>Exact activation checklist</h3>
                      <ol>
                        {provider.activationChecklist.map((item) => (
                          <li key={item}>
                            <span />
                            <p>{item}</p>
                          </li>
                        ))}
                      </ol>
                    </div>
                  ) : null}
                  <div className="provider-actions">
                    {provider.connection === "connected" ? (
                      provider.consentScopes?.length ? null : (
                        <Button
                          variant="secondary"
                          disabled={Boolean(working)}
                          onClick={() => void action(provider, "disconnect")}
                        >
                          <Unplug size={16} /> Disconnect
                        </Button>
                      )
                    ) : (
                      <Button
                        disabled={
                          provider.consent !== "granted" ||
                          activationRequired ||
                          Boolean(working)
                        }
                        onClick={() => void action(provider, "connect")}
                      >
                        <PlugZap size={16} />{" "}
                        {activationRequired
                          ? "Activation required"
                          : `Connect ${provider.label}`}
                      </Button>
                    )}
                    <Button
                      variant="quiet"
                      disabled={Boolean(working)}
                      onClick={() => void action(provider, "test")}
                    >
                      <TestTube2 size={16} /> Test{" "}
                      {provider.fake || demoMode ? "contract" : "connection"}
                    </Button>
                  </div>
                </div>
              ) : null}
            </Card>
          );
        })}
      </div>
    </div>
  );
}

function categoryDescription(category: string): string {
  const descriptions: Record<string, string> = {
    "Identity & attribution":
      "Your machine-local stable handle for inspectable human provenance.",
    Asking: "Defaults that preserve the asker's low-friction path.",
    Answering:
      "Capture, evaluation, and approval behavior for answer sessions.",
    "Audio & transcription":
      "Machine-local media handling and transcription preferences.",
    Maintenance: "Repository-wide background work and polling.",
    Appearance: "Personal display choices for this machine.",
  };
  return descriptions[category] ?? "Project and personal behavior.";
}

function extractTestResult(value: unknown): { ok: boolean; message: string } {
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.ok === "boolean") {
      return {
        ok: record.ok,
        message:
          typeof record.detail === "string"
            ? record.detail
            : record.ok
              ? "The provider returned a healthy contract response."
              : "The provider test did not pass.",
      };
    }
    if (record.test && typeof record.test === "object") {
      const nested = record.test as Record<string, unknown>;
      return {
        ok: nested.ok !== false,
        message:
          typeof nested.message === "string"
            ? nested.message
            : "The provider returned a healthy contract response.",
      };
    }
  }
  return {
    ok: false,
    message: "The provider returned an unrecognized test response.",
  };
}

function slug(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
