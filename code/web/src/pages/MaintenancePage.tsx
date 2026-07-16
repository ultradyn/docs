import {
  Activity,
  AlertTriangle,
  Bot,
  CheckCircle2,
  ChevronRight,
  CircleDashed,
  Clock3,
  CodeXml,
  FileCheck2,
  GitPullRequest,
  History,
  Play,
  Plus,
  RefreshCw,
  ServerCog,
  ShieldCheck,
  Sparkles,
  WandSparkles,
} from "lucide-react";
import { type FormEvent, useMemo, useState } from "react";

import { useActorIdentity, useApi } from "../api-context.js";
import { formatRelativeTime, readableState } from "../model.js";
import { useAsyncResource, useDocumentTitle } from "../hooks.js";
import type { AgentDefinitionStatus, ChangeRequestInfo } from "../types.js";
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  InlineNotice,
  LoadingState,
  PageHeader,
  StatusPill,
} from "../components/ui.js";
import { ActorIdentityNotice } from "../components/ActorIdentityNotice.js";

type MaintenanceTab = "operations" | "agents";

export function MaintenancePage() {
  useDocumentTitle("Maintenance");
  const { api, latestEvent } = useApi();
  const [tab, setTab] = useState<MaintenanceTab>("operations");
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string>();
  const maintenance = useAsyncResource(
    () => api.maintenance(),
    [api, latestEvent?.type === "maintenance.updated" ? latestEvent.at : ""],
  );
  const agents = useAsyncResource(() => api.agents(), [api]);

  async function runNow() {
    setRunning(true);
    setRunError(undefined);
    try {
      await api.maintenanceRun();
      maintenance.reload();
    } catch (caught) {
      setRunError(
        caught instanceof Error ? caught.message : "Maintenance could not run.",
      );
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="maintenance-page">
      <PageHeader
        eyebrow="Maintainer mode"
        title="Maintenance"
        description="Background polling creates locally claimable work. It never performs a review under somebody else’s identity."
        actions={
          <Button
            variant="secondary"
            disabled={running}
            onClick={() => void runNow()}
          >
            {running ? (
              <CircleDashed className="spin" size={16} />
            ) : (
              <RefreshCw size={16} />
            )}{" "}
            Poll now
          </Button>
        }
      />
      {runError ? (
        <InlineNotice tone="danger" title="Maintenance run failed">
          <p>{runError}</p>
        </InlineNotice>
      ) : null}
      <div
        className="settings-tabs maintenance-tabs"
        role="tablist"
        aria-label="Maintenance sections"
      >
        <button
          role="tab"
          aria-selected={tab === "operations"}
          className={tab === "operations" ? "active" : ""}
          onClick={() => setTab("operations")}
        >
          <ServerCog size={17} /> Operations
        </button>
        <button
          role="tab"
          aria-selected={tab === "agents"}
          className={tab === "agents" ? "active" : ""}
          onClick={() => setTab("agents")}
        >
          <Bot size={17} /> Agents
        </button>
      </div>
      {tab === "operations" ? (
        <Operations resource={maintenance} />
      ) : (
        <Agents resource={agents} />
      )}
    </div>
  );
}

function Operations({
  resource,
}: {
  resource: ReturnType<
    typeof useAsyncResource<
      Awaited<ReturnType<ReturnType<typeof useApi>["api"]["maintenance"]>>
    >
  >;
}) {
  const { api } = useApi();
  const actorIdentity = useActorIdentity();
  const [review, setReview] = useState<ChangeRequestInfo>();
  const [reviewAction, setReviewAction] = useState<string>();
  const [reviewError, setReviewError] = useState<string>();
  const state = resource.data;

  async function openReview(id: string) {
    setReviewAction("open");
    setReviewError(undefined);
    try {
      setReview(await api.changeRequest(id));
    } catch (caught) {
      setReviewError(
        caught instanceof Error
          ? caught.message
          : "The change request could not be opened.",
      );
    } finally {
      setReviewAction(undefined);
    }
  }

  async function reviewDecision(action: "approve" | "merge") {
    if (!review || actorIdentity.status !== "configured") return;
    setReviewAction(action);
    setReviewError(undefined);
    try {
      const updated = await api.changeRequestReviewAction(
        review.id,
        action,
        action === "approve"
          ? { by: actorIdentity.handle, kind: "maintainer" }
          : { by: actorIdentity.handle },
      );
      setReview(updated);
      resource.reload();
    } catch (caught) {
      setReviewError(
        caught instanceof Error
          ? caught.message
          : "The review action could not be completed.",
      );
    } finally {
      setReviewAction(undefined);
    }
  }
  if (resource.loading && !state)
    return <LoadingState label="Reading durable maintenance cursors…" />;
  if (resource.error)
    return <ErrorState error={resource.error} retry={resource.reload} />;
  if (!state) return null;
  return (
    <>
      <div className="maintenance-metrics">
        <Card>
          <span className="metric-icon green">
            <Activity size={19} />
          </span>
          <p>
            <small>Scheduler</small>
            <strong>{state.polling ? "Polling" : "Paused"}</strong>
            <span>
              {state.intervalSeconds
                ? `Every ${Math.round(state.intervalSeconds / 60)} minutes`
                : "Manual runs only"}
            </span>
          </p>
        </Card>
        <Card>
          <span className="metric-icon blue">
            <Clock3 size={19} />
          </span>
          <p>
            <small>Last completed</small>
            <strong>{formatRelativeTime(state.lastRunAt)}</strong>
            <span>
              {state.nextRunAt
                ? `Next ${formatRelativeTime(state.nextRunAt)}`
                : "No run scheduled"}
            </span>
          </p>
        </Card>
        <Card>
          <span className="metric-icon amber">
            <GitPullRequest size={19} />
          </span>
          <p>
            <small>Claimable work</small>
            <strong>
              {
                state.tasks.filter(
                  (task) =>
                    task.status === "ready" && task.kind !== "checkpoint",
                ).length
              }
            </strong>
            <span>Across local and remote backends</span>
          </p>
        </Card>
        <Card>
          <span className="metric-icon violet">
            <History size={19} />
          </span>
          <p>
            <small>Pending checkpoints</small>
            <strong>{state.pendingCheckpoints ?? 0}</strong>
            <span>Visible until committed</span>
          </p>
        </Card>
      </div>
      <div className="maintenance-layout">
        <section
          className="maintenance-tasks"
          aria-labelledby="maintenance-task-heading"
        >
          <div className="section-heading">
            <div>
              <ShieldCheck size={18} />
              <div>
                <h2 id="maintenance-task-heading">Work needing a person</h2>
                <p>Claim locally under your own role and identity</p>
              </div>
            </div>
            <StatusPill tone={state.tasks.length ? "warning" : "positive"}>
              {state.tasks.length} open
            </StatusPill>
          </div>
          {!state.tasks.length ? (
            <EmptyState
              title="No maintenance work"
              description="Polling cursors are healthy and no local review tasks are waiting."
            />
          ) : (
            state.tasks.map((task) => (
              <Card className="maintenance-task" key={task.id}>
                <span className="task-kind">
                  {task.kind === "review" ? (
                    <GitPullRequest size={18} />
                  ) : (
                    <FileCheck2 size={18} />
                  )}
                </span>
                <div>
                  <div>
                    <StatusPill
                      tone={
                        task.status === "blocked"
                          ? "danger"
                          : task.status === "ready"
                            ? "warning"
                            : "neutral"
                      }
                    >
                      {readableState(task.status)}
                    </StatusPill>
                    {task.repository ? <code>{task.repository}</code> : null}
                  </div>
                  <h3>{task.title}</h3>
                  <p>{task.detail}</p>
                  <small>{formatRelativeTime(task.updatedAt)}</small>
                </div>
                {task.kind === "review" || task.kind === "rereview" ? (
                  <Button
                    variant="quiet"
                    disabled={reviewAction === "open"}
                    onClick={() => void openReview(task.id)}
                  >
                    Open <ChevronRight size={15} />
                  </Button>
                ) : null}
              </Card>
            ))
          )}
          {review ? (
            <Card className="maintenance-review">
              <div className="section-heading">
                <div>
                  <GitPullRequest size={18} />
                  <div>
                    <h2>{review.branch}</h2>
                    <p>{review.summary}</p>
                  </div>
                </div>
                <StatusPill
                  tone={
                    review.state === "blocked"
                      ? "danger"
                      : review.state === "merged"
                        ? "positive"
                        : "info"
                  }
                >
                  {readableState(review.state)}
                </StatusPill>
              </div>
              <div className="change-checks">
                {review.checks.map((check) => (
                  <div key={check.id} className={check.status}>
                    {check.status === "passed" ? (
                      <CheckCircle2 size={16} />
                    ) : (
                      <AlertTriangle size={16} />
                    )}
                    <span>
                      <strong>{check.label}</strong>
                      <small>{check.detail}</small>
                    </span>
                  </div>
                ))}
              </div>
              <details className="change-diff">
                <summary>Review literal Git diff</summary>
                <pre>{review.diff}</pre>
              </details>
              {reviewError ? (
                <p className="field-error" role="alert">
                  {reviewError}
                </p>
              ) : null}
              <div className="review-actions">
                {review.state === "open" ? (
                  <Button
                    disabled={
                      Boolean(reviewAction) ||
                      actorIdentity.status !== "configured" ||
                      review.checks.some((check) => check.status === "failed")
                    }
                    onClick={() => void reviewDecision("approve")}
                  >
                    {reviewAction === "approve" ? (
                      <CircleDashed className="spin" size={16} />
                    ) : (
                      <ShieldCheck size={16} />
                    )}{" "}
                    Approve as maintainer
                  </Button>
                ) : null}
                {review.state === "approved" ? (
                  <Button
                    disabled={
                      Boolean(reviewAction) ||
                      actorIdentity.status !== "configured"
                    }
                    onClick={() => void reviewDecision("merge")}
                  >
                    {reviewAction === "merge" ? (
                      <CircleDashed className="spin" size={16} />
                    ) : (
                      <GitPullRequest size={16} />
                    )}{" "}
                    Merge locally
                  </Button>
                ) : null}
                {review.state === "open" &&
                actorIdentity.status !== "configured" ? (
                  <ActorIdentityNotice />
                ) : null}
                <Button variant="quiet" onClick={() => setReview(undefined)}>
                  Close
                </Button>
              </div>
            </Card>
          ) : reviewError ? (
            <InlineNotice tone="danger" title="Change request unavailable">
              <p>{reviewError}</p>
            </InlineNotice>
          ) : null}
        </section>
        <aside className="cursor-panel">
          <div className="section-heading">
            <div>
              <Activity size={18} />
              <div>
                <h2>Source cursors</h2>
                <p>Durable, idempotent poll positions</p>
              </div>
            </div>
          </div>
          {state.cursors?.map((cursor) => (
            <div className="cursor-row" key={cursor.source}>
              <span
                className={
                  cursor.status === "healthy" ? "healthy" : "attention"
                }
              >
                {cursor.status === "healthy" ? (
                  <CheckCircle2 size={16} />
                ) : (
                  <AlertTriangle size={16} />
                )}
              </span>
              <p>
                <strong>{cursor.source}</strong>
                <small>
                  {cursor.status}
                  {cursor.updatedAt
                    ? ` · ${formatRelativeTime(cursor.updatedAt)}`
                    : ""}
                </small>
              </p>
            </div>
          ))}
        </aside>
      </div>
    </>
  );
}

function Agents({
  resource,
}: {
  resource: ReturnType<typeof useAsyncResource<AgentDefinitionStatus[]>>;
}) {
  const { api } = useApi();
  const [fixtureRun, setFixtureRun] = useState<string>();
  const [fixtureError, setFixtureError] = useState<string>();
  const [mode, setMode] = useState<"create" | "update">("create");
  const [target, setTarget] = useState("");
  const [request, setRequest] = useState("");
  const [smithRunning, setSmithRunning] = useState(false);
  const [smithResult, setSmithResult] = useState<string>();
  const sorted = useMemo(
    () =>
      [...(resource.data ?? [])].sort((a, b) => a.label.localeCompare(b.label)),
    [resource.data],
  );

  async function fixtures(agent: AgentDefinitionStatus) {
    setFixtureRun(agent.id);
    setFixtureError(undefined);
    try {
      await api.agentFixtures(agent.id);
      resource.reload();
    } catch (caught) {
      setFixtureError(
        caught instanceof Error ? caught.message : "Fixtures could not run.",
      );
    } finally {
      setFixtureRun(undefined);
    }
  }

  async function smith(event: FormEvent) {
    event.preventDefault();
    if (!request.trim()) return;
    setSmithRunning(true);
    setSmithResult(undefined);
    try {
      await api.agentSmith({
        mode,
        request: request.trim(),
        ...(mode === "update" && target ? { target } : {}),
      });
      setSmithResult(
        "A local agent-definition change request was created with schema and fixture work. Review it before merge.",
      );
      setRequest("");
    } catch (caught) {
      setSmithResult(
        caught instanceof Error
          ? caught.message
          : "Agent-Smith could not create the change request.",
      );
    } finally {
      setSmithRunning(false);
    }
  }

  return (
    <div className="agents-maintenance">
      <InlineNotice
        tone="info"
        title="Definitions hot-load from repository HEAD"
      >
        <p>
          Prompts, schemas, and golden fixtures are portable source. Every
          evaluator runs in a fresh context; changes travel through the same
          isolated change-request lane as documentation.
        </p>
      </InlineNotice>
      {resource.loading && !resource.data ? (
        <LoadingState label="Loading dynamic agent definitions…" />
      ) : null}
      {resource.error ? (
        <ErrorState error={resource.error} retry={resource.reload} />
      ) : null}
      {fixtureError ? (
        <InlineNotice tone="danger" title="Fixture run failed">
          <p>{fixtureError}</p>
        </InlineNotice>
      ) : null}
      <div className="agent-grid">
        {sorted.map((agent) => (
          <Card className="agent-card" key={agent.id}>
            <div className="agent-card-head">
              <span>
                <Bot size={20} />
              </span>
              <div>
                <h2>{agent.label}</h2>
                <p>{agent.role}</p>
              </div>
              <StatusPill
                tone={
                  agent.fixtureStatus === "passing"
                    ? "positive"
                    : agent.fixtureStatus === "failing"
                      ? "danger"
                      : "warning"
                }
              >
                {agent.fixtureStatus === "passing"
                  ? "Fixtures pass"
                  : agent.fixtureStatus === "failing"
                    ? "Fixtures fail"
                    : "Not run"}
              </StatusPill>
            </div>
            <code>{agent.sourcePath}</code>
            <div className="agent-flags">
              <span>
                <CodeXml size={13} /> Schema {agent.schemaStatus ?? "unknown"}
              </span>
              <span>
                <Sparkles size={13} />{" "}
                {agent.freshContext ? "Fresh context" : "Shared context"}
              </span>
              <span>
                <FileCheck2 size={13} /> {agent.fixtureCount} fixtures
              </span>
            </div>
            {agent.capabilities?.length ? (
              <div className="capability-list">
                {agent.capabilities.map((capability) => (
                  <span key={capability}>{capability}</span>
                ))}
              </div>
            ) : null}
            <div className="agent-card-foot">
              <small>
                {agent.lastFixtureRunAt
                  ? `Last run ${formatRelativeTime(agent.lastFixtureRunAt)}`
                  : "Fixtures have not run on this machine"}
              </small>
              <Button
                variant="quiet"
                disabled={Boolean(fixtureRun)}
                onClick={() => void fixtures(agent)}
              >
                {fixtureRun === agent.id ? (
                  <CircleDashed className="spin" size={15} />
                ) : (
                  <Play size={15} />
                )}{" "}
                Run fixtures
              </Button>
            </div>
          </Card>
        ))}
      </div>
      <Card className="agent-smith-card">
        <div className="smith-intro">
          <span>
            <WandSparkles size={22} />
          </span>
          <div>
            <p className="eyebrow">Agent-Smith</p>
            <h2>Create or improve an agent</h2>
            <p>
              Describe the capability. Agent-Smith proposes definition source, a
              structured output schema, and golden fixtures—never a direct
              change to the default branch.
            </p>
          </div>
        </div>
        <form onSubmit={(event) => void smith(event)}>
          <div
            className="smith-mode"
            role="group"
            aria-label="Agent change mode"
          >
            <button
              type="button"
              aria-pressed={mode === "create"}
              className={mode === "create" ? "active" : ""}
              onClick={() => setMode("create")}
            >
              <Plus size={15} /> New agent
            </button>
            <button
              type="button"
              aria-pressed={mode === "update"}
              className={mode === "update" ? "active" : ""}
              onClick={() => setMode("update")}
            >
              <RefreshCw size={15} /> Update existing
            </button>
          </div>
          {mode === "update" ? (
            <label>
              <span>Agent to update</span>
              <select
                value={target}
                onChange={(event) => setTarget(event.target.value)}
                required
              >
                <option value="">Choose an agent</option>
                {sorted.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.label}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label>
            <span>What should this agent do?</span>
            <textarea
              rows={5}
              value={request}
              onChange={(event) => setRequest(event.target.value)}
              placeholder="Describe its narrow responsibility, permitted inputs, decisive output, and any context it must not receive."
            />
          </label>
          <div className="smith-submit">
            <p>
              <ShieldCheck size={14} /> Source, schema, and ≥3 fixtures are
              required
            </p>
            <Button type="submit" disabled={!request.trim() || smithRunning}>
              {smithRunning ? (
                <CircleDashed className="spin" size={16} />
              ) : (
                <WandSparkles size={16} />
              )}{" "}
              Create change request
            </Button>
          </div>
        </form>
        {smithResult ? (
          <InlineNotice tone="positive" title="Agent-Smith finished">
            <p>{smithResult}</p>
          </InlineNotice>
        ) : null}
      </Card>
    </div>
  );
}
