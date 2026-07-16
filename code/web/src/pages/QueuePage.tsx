import {
  ArrowUpDown,
  CalendarClock,
  Check,
  ChevronRight,
  CircleUserRound,
  Filter,
  GitFork,
  ListFilter,
  Mic2,
  Search,
  Tag,
  UsersRound,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { useActorIdentity, useApi } from "../api-context.js";
import { formatRelativeTime, sortQuestions } from "../model.js";
import { useAsyncResource, useDocumentTitle } from "../hooks.js";
import type { PriorityTier, Question } from "../types.js";
import {
  Button,
  Card,
  ComboBox,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  PriorityBadge,
  StateText,
  StatusPill,
} from "../components/ui.js";
import { ActorIdentityNotice } from "../components/ActorIdentityNotice.js";

const buckets = [
  { value: "all", label: "All open" },
  { value: "active", label: "Active" },
  { value: "deferred", label: "Deferred" },
  { value: "answered", label: "Answered" },
];
const tiers: Array<PriorityTier | "all"> = [
  "all",
  "P1",
  "P2",
  "P3",
  "P4",
  "P5",
];

export function QueuePage() {
  useDocumentTitle("Question queue");
  const { api, latestEvent } = useApi();
  const { questionId } = useParams();
  const [bucket, setBucket] = useState("all");
  const [tier, setTier] = useState<PriorityTier | "all">("all");
  const [query, setQuery] = useState("");
  const [settledQuery, setSettledQuery] = useState("");

  useEffect(() => {
    const timeout = window.setTimeout(() => setSettledQuery(query.trim()), 180);
    return () => window.clearTimeout(timeout);
  }, [query]);

  const queue = useAsyncResource(
    () => api.questions({ bucket, tier, q: settledQuery }),
    [
      api,
      bucket,
      tier,
      settledQuery,
      latestEvent?.type === "question.updated" ? latestEvent.at : "",
    ],
  );
  const sorted = useMemo(() => sortQuestions(queue.data ?? []), [queue.data]);

  return (
    <div className="queue-page">
      <PageHeader
        eyebrow="Breadth before depth"
        title="Question queue"
        description="Priority rules make urgency legible. Human overrides remain direct, explained, and reversible."
        actions={
          <StatusPill
            tone={
              sorted.some((item) => item.tier === "P1") ? "danger" : "positive"
            }
          >
            {sorted.filter((item) => item.tier === "P1").length} P1 blockers
          </StatusPill>
        }
      />

      <div className="queue-toolbar" aria-label="Queue filters">
        <div className="bucket-tabs" role="group" aria-label="Queue bucket">
          {buckets.map((item) => (
            <button
              type="button"
              key={item.value}
              aria-pressed={bucket === item.value}
              className={bucket === item.value ? "active" : ""}
              onClick={() => setBucket(item.value)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <label className="search-field">
          <Search aria-hidden="true" size={17} />
          <span className="visually-hidden">Search questions</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search questions and goals"
          />
        </label>
        <div className="select-field">
          <Filter aria-hidden="true" size={16} />
          <ComboBox
            label="Priority tier"
            value={tier}
            options={tiers.map((item) => ({
              value: item,
              label: item === "all" ? "Every tier" : `${item} only`,
            }))}
            onChange={setTier}
          />
        </div>
      </div>

      <div className={`queue-layout${questionId ? " has-selection" : ""}`}>
        <section className="queue-list" aria-label="Questions">
          <div className="queue-list-heading">
            <span>
              <ListFilter aria-hidden="true" size={16} /> {sorted.length}{" "}
              question{sorted.length === 1 ? "" : "s"}
            </span>
            <span>
              <ArrowUpDown aria-hidden="true" size={14} /> Tier, then age
            </span>
          </div>
          {queue.loading && !queue.data ? (
            <LoadingState label="Reading the committed queue…" />
          ) : null}
          {queue.error ? (
            <ErrorState error={queue.error} retry={queue.reload} />
          ) : null}
          {!queue.loading && !queue.error && !sorted.length ? (
            <EmptyState
              title="No questions match"
              description="Try a different bucket, tier, or search phrase. No queue records were changed."
            />
          ) : null}
          {sorted.map((question) => (
            <QuestionRow
              key={question.id}
              question={question}
              selected={question.id === questionId}
            />
          ))}
        </section>
        <aside className="queue-detail" aria-label="Question detail">
          {questionId ? (
            <QuestionDetail id={questionId} onUpdated={queue.reload} />
          ) : (
            <QueueGuide />
          )}
        </aside>
      </div>
    </div>
  );
}

function QuestionRow({
  question,
  selected,
}: {
  question: Question;
  selected: boolean;
}) {
  return (
    <Link
      className={`question-row${selected ? " selected" : ""}`}
      to={`/queue/${question.id}`}
      aria-current={selected ? "true" : undefined}
    >
      <div className="question-row-top">
        <PriorityBadge tier={question.tier} />
        <StateText value={question.state} />
        <span className="question-age">
          {formatRelativeTime(question.createdAt)}
        </span>
      </div>
      <h2>{question.title}</h2>
      <p>{question.question}</p>
      <div className="question-row-foot">
        <span>
          {question.goals.slice(0, 2).map((goal) => (
            <small key={goal}>{goal}</small>
          ))}
          {question.goals.length > 2 ? (
            <small>+{question.goals.length - 2}</small>
          ) : null}
        </span>
        <ChevronRight aria-hidden="true" size={17} />
      </div>
    </Link>
  );
}

function QuestionDetail({
  id,
  onUpdated,
}: {
  id: string;
  onUpdated: () => void;
}) {
  const { api } = useApi();
  const actorIdentity = useActorIdentity();
  const navigate = useNavigate();
  const resource = useAsyncResource(() => api.question(id), [api, id]);
  const [saving, setSaving] = useState<string>();
  const [error, setError] = useState<string>();
  const [rationale, setRationale] = useState(
    "Manual override after reviewing the question context.",
  );
  const question = resource.data;

  async function override(tier: PriorityTier) {
    if (!question || saving || actorIdentity.status !== "configured") return;
    setSaving(tier);
    setError(undefined);
    try {
      await api.priority(
        question.id,
        tier,
        rationale.trim() || "Manual priority override.",
        actorIdentity.handle,
      );
      resource.reload();
      onUpdated();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Priority could not be changed.",
      );
    } finally {
      setSaving(undefined);
    }
  }

  async function claim() {
    if (!question || saving) return;
    if (question.state === "in-answer") {
      navigate(`/answer/${question.id}`);
      return;
    }
    if (actorIdentity.status !== "configured") return;
    setSaving("claim");
    setError(undefined);
    try {
      await api.claim(question.id, actorIdentity.handle);
      navigate(`/answer/${question.id}`);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Question could not be claimed.",
      );
      setSaving(undefined);
    }
  }

  if (resource.loading && !question)
    return <LoadingState label="Opening question record…" />;
  if (resource.error)
    return <ErrorState error={resource.error} retry={resource.reload} />;
  if (!question)
    return (
      <EmptyState
        title="Question unavailable"
        description="It may have moved to another queue bucket. Refresh the queue to locate it."
      />
    );

  return (
    <div className="detail-panel">
      <div className="detail-topline">
        <div>
          <PriorityBadge tier={question.tier} />
          <StateText value={question.state} />
        </div>
        <code>{question.id}</code>
      </div>
      <h2>{question.title}</h2>
      <blockquote>{question.rawQuestion ?? question.question}</blockquote>
      {question.chat ? (
        <details className="detail-disclosure">
          <summary>Conversation context</summary>
          <p>{question.chat}</p>
        </details>
      ) : null}

      <dl className="detail-facts">
        <div>
          <dt>
            <CalendarClock aria-hidden="true" size={15} /> Logged
          </dt>
          <dd>{new Date(question.createdAt).toLocaleString()}</dd>
        </div>
        <div>
          <dt>
            <UsersRound aria-hidden="true" size={15} /> Askers
          </dt>
          <dd>
            {question.askers?.length
              ? question.askers.map((asker) => asker.name).join(", ")
              : "Not recorded"}
          </dd>
        </div>
        <div>
          <dt>
            <Tag aria-hidden="true" size={15} /> Goals
          </dt>
          <dd>{question.goals.join(", ") || "No goals"}</dd>
        </div>
        <div>
          <dt>
            <GitFork aria-hidden="true" size={15} /> Origin
          </dt>
          <dd>
            {question.provenance?.kind === "generated"
              ? `Generated from ${question.provenance.parent ?? "a parent question"}`
              : "Raw asker question"}
          </dd>
        </div>
      </dl>

      <div className="rationale-box">
        <strong>Why {question.tier}?</strong>
        <p>{question.rationale ?? "No rationale was recorded."}</p>
      </div>

      <section className="priority-override" aria-labelledby="priority-title">
        <div>
          <h3 id="priority-title">Override priority</h3>
          <p>The rationale enters the inspectable event history.</p>
        </div>
        <label>
          <span>Override rationale</span>
          <input
            value={rationale}
            onChange={(event) => setRationale(event.target.value)}
          />
        </label>
        <div className="priority-grid">
          {tiers.slice(1).map((candidate) => {
            const value = candidate as PriorityTier;
            return (
              <button
                key={value}
                type="button"
                className={question.tier === value ? "current" : ""}
                disabled={
                  Boolean(saving) || actorIdentity.status !== "configured"
                }
                onClick={() => void override(value)}
              >
                {saving === value ? "…" : value}
                {question.tier === value ? (
                  <Check aria-hidden="true" size={13} />
                ) : null}
              </button>
            );
          })}
        </div>
      </section>
      {actorIdentity.status !== "configured" ? <ActorIdentityNotice /> : null}
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
      {["active", "reopened", "in-answer"].includes(question.state) ? (
        <Button
          className="detail-primary-action"
          onClick={() => void claim()}
          disabled={
            Boolean(saving) ||
            (question.state !== "in-answer" &&
              actorIdentity.status !== "configured")
          }
        >
          <Mic2 aria-hidden="true" size={17} />{" "}
          {question.state === "in-answer"
            ? "Continue answer"
            : "Claim and answer"}
        </Button>
      ) : (
        <p className="muted-copy">
          Answering is unavailable while {question.state}.
        </p>
      )}
    </div>
  );
}

function QueueGuide() {
  return (
    <Card className="queue-guide">
      <span className="guide-icon">
        <CircleUserRound aria-hidden="true" size={23} />
      </span>
      <h2>Select a question</h2>
      <p>
        Inspect its immutable ask, provenance, goals, and priority rationale
        before claiming it.
      </p>
      <ol>
        <li>
          <strong>P1</strong> contradictions and reopened rejections
        </li>
        <li>
          <strong>P2</strong> demanded or active goal gaps
        </li>
        <li>
          <strong>P3–P5</strong> raw questions through deferred depth
        </li>
      </ol>
    </Card>
  );
}
