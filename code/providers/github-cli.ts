import type {
  ChangeRequestDraft,
  GitHostPollRequest,
  GitHostPollResult,
  GitHostProvider,
  ProcessRunner,
  ProviderStatus,
  PublishedChangeRequest,
} from "./contracts.js";
import { ExecaProcessRunner } from "./cli-delegates.js";

interface CursorState {
  etag?: string;
  heads: Record<string, string>;
}

interface GitHubPull {
  number: number;
  html_url?: string;
  draft?: boolean;
  head: { sha: string };
  requested_reviewers?: unknown[];
}

function decodeCursor(cursor: string | null): CursorState {
  if (!cursor) return { heads: {} };
  try {
    return JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as CursorState;
  } catch {
    return { heads: {} };
  }
}

function encodeCursor(state: CursorState): string {
  return Buffer.from(JSON.stringify(state)).toString("base64url");
}

function parseIncludedResponse(stdout: string): {
  etag?: string;
  pulls: GitHubPull[];
} {
  const boundary = /\r?\n\r?\n/u.exec(stdout);
  const split = boundary?.index ?? -1;
  const headers = split >= 0 ? stdout.slice(0, split) : "";
  const body =
    split >= 0
      ? stdout.slice(split + (boundary?.[0].length ?? 0)).trim()
      : stdout.trim();
  const etag = /^etag:\s*(.+)$/imu.exec(headers)?.[1]?.trim();
  const pulls = body ? (JSON.parse(body) as GitHubPull[]) : [];
  return { ...(etag ? { etag } : {}), pulls };
}

export class GhCliGitHostProvider implements GitHostProvider {
  readonly id = "github-cli";
  readonly #runner: ProcessRunner;
  readonly #cwd: string | undefined;

  constructor(options: { runner?: ProcessRunner; cwd?: string } = {}) {
    this.#runner = options.runner ?? new ExecaProcessRunner();
    this.#cwd = options.cwd;
  }

  async status(): Promise<ProviderStatus> {
    try {
      const result = await this.#runner.run(
        "gh",
        ["auth", "status", "--hostname", "github.com"],
        {
          ...(this.#cwd ? { cwd: this.#cwd } : {}),
        },
      );
      return {
        id: this.id,
        kind: "git-host",
        label: "GitHub CLI delegated authorization",
        availability:
          result.exitCode === 0 ? "available" : "activation-required",
        consent: "granted",
        streaming: "none",
        ...(result.exitCode === 0
          ? {}
          : { reason: "GitHub CLI is not authorized." }),
      };
    } catch {
      return {
        id: this.id,
        kind: "git-host",
        label: "GitHub CLI delegated authorization",
        availability: "activation-required",
        consent: "granted",
        streaming: "none",
        reason: "GitHub CLI is not installed or authorized.",
      };
    }
  }

  async publish(request: ChangeRequestDraft): Promise<PublishedChangeRequest> {
    const result = await this.#runner.run(
      "gh",
      [
        "pr",
        "create",
        "--repo",
        request.repository,
        "--head",
        request.branch,
        "--base",
        request.base ?? "main",
        "--title",
        request.title,
        "--body",
        request.body,
      ],
      { ...(this.#cwd ? { cwd: this.#cwd } : {}) },
    );
    if (result.exitCode !== 0)
      throw new Error(result.stderr || "gh pr create failed.");
    const url = result.stdout.trim().split(/\r?\n/u).at(-1);
    if (!url) throw new Error("gh pr create returned no pull-request URL.");
    return {
      id: url.split("/").at(-1) ?? url,
      url,
      repository: request.repository,
      branch: request.branch,
      state: "open",
    };
  }

  async poll(request: GitHostPollRequest): Promise<GitHostPollResult> {
    const previous = decodeCursor(request.cursor);
    const args = [
      "api",
      "--include",
      "-H",
      "Accept: application/vnd.github+json",
      ...(previous.etag ? ["-H", `If-None-Match: ${previous.etag}`] : []),
      `repos/${request.repository}/pulls?state=open&per_page=100`,
    ];
    const result = await this.#runner.run("gh", args, {
      ...(this.#cwd ? { cwd: this.#cwd } : {}),
    });
    if (result.exitCode !== 0)
      throw new Error(result.stderr || "gh api pull polling failed.");
    if (/^HTTP\/\S+\s+304\b/mu.test(result.stdout)) {
      return { cursor: request.cursor ?? encodeCursor(previous), tasks: [] };
    }
    const parsed = parseIncludedResponse(result.stdout);
    const heads: Record<string, string> = {};
    const tasks: GitHostPollResult["tasks"] = [];
    for (const pull of parsed.pulls) {
      const key = String(pull.number);
      heads[key] = pull.head.sha;
      const oldHead = previous.heads[key];
      if (!oldHead) {
        tasks.push({
          id: `github:${request.repository}#${pull.number}:${pull.head.sha}`,
          changeRequestId: String(pull.number),
          revision: pull.head.sha,
          reason: pull.requested_reviewers?.length
            ? "review-requested"
            : "opened",
        });
      } else if (oldHead !== pull.head.sha) {
        tasks.push({
          id: `github:${request.repository}#${pull.number}:${pull.head.sha}`,
          changeRequestId: String(pull.number),
          revision: pull.head.sha,
          reason: "updated",
        });
      }
    }
    return {
      cursor: encodeCursor({
        ...(parsed.etag ? { etag: parsed.etag } : {}),
        heads,
      }),
      tasks,
    };
  }
}
