import {
  ArrowUp,
  BookOpenText,
  Check,
  ChevronRight,
  CircleDashed,
  FileText,
  Lightbulb,
  MessageCircleMore,
  Sparkles,
} from "lucide-react";
import { type FormEvent, type KeyboardEvent, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { useActorIdentity, useApi } from "../api-context.js";
import { normaliseQuestion } from "../model.js";
import { useAsyncResource, useDocumentTitle } from "../hooks.js";
import type { AskResponse, GoalDefinition } from "../types.js";
import {
  Button,
  Card,
  ErrorState,
  GoalStatusBadge,
  InlineNotice,
  LoadingState,
  PageHeader,
  PriorityBadge,
} from "../components/ui.js";
import { ActorIdentityNotice } from "../components/ActorIdentityNotice.js";

interface Exchange {
  id: number;
  request: AskPayload;
  response?: AskResponse;
  error?: string;
  pending?: boolean;
}

interface AskPayload {
  question: string;
  goals: string[];
  asker: string;
  chat?: string;
}

const suggestedQuestions = [
  "What happens to raw audio after transcription?",
  "How can a reviewer work without GitHub access?",
  "Where is personal configuration stored?",
];

export function AskPage() {
  useDocumentTitle("Ask");
  const { api } = useApi();
  const actorIdentity = useActorIdentity();
  const goalsResource = useAsyncResource(() => api.goals(), [api]);
  const [question, setQuestion] = useState("");
  const [selectedGoals, setSelectedGoals] = useState<string[]>([
    "documentation",
  ]);
  const [customGoal, setCustomGoal] = useState("");
  const [customGoalError, setCustomGoalError] = useState("");
  const [customGoals, setCustomGoals] = useState<GoalDefinition[]>([]);
  const [askerOverride, setAskerOverride] = useState<string>();
  const [chatContext, setChatContext] = useState("");
  const [showContext, setShowContext] = useState(false);
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const busy = exchanges.some((exchange) => exchange.pending);
  const asker =
    askerOverride ??
    (actorIdentity.status === "configured" ? actorIdentity.handle : "");

  const goals = useMemo(() => {
    const loaded = goalsResource.data ?? [];
    return loaded.length ? loaded : fallbackGoals;
  }, [goalsResource.data]);
  const goalChoices = useMemo(() => {
    const vocabulary = new Set(goals.map((goal) => goal.id));
    return [
      ...goals,
      ...customGoals.filter((goal) => !vocabulary.has(goal.id)),
    ];
  }, [customGoals, goals]);

  function toggleGoal(goal: string) {
    setSelectedGoals((current) =>
      current.includes(goal)
        ? current.filter((item) => item !== goal)
        : [...current, goal],
    );
  }

  function addCustomGoal() {
    const label = customGoal.trim().replace(/\s+/gu, " ");
    const id = normaliseGoalTag(label);
    if (!id) {
      setCustomGoalError(
        "Use at least one letter or number so the goal can be saved as a tag.",
      );
      return;
    }

    if (!goalChoices.some((goal) => goal.id === id)) {
      setCustomGoals((current) => [
        ...current,
        {
          id,
          label,
          description: `Custom goal: ${label}`,
        },
      ]);
    }
    setSelectedGoals((current) =>
      current.includes(id) ? current : [...current, id],
    );
    setCustomGoal("");
    setCustomGoalError("");
  }

  function onCustomGoalKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      addCustomGoal();
    }
  }

  async function sendExchange(id: number, request: AskPayload) {
    try {
      const rawResponse = await api.ask(request);
      const response =
        rawResponse.kind === "logged"
          ? {
              ...rawResponse,
              question: normaliseQuestion(rawResponse.question),
            }
          : rawResponse;
      setExchanges((current) =>
        current.map((exchange) =>
          exchange.id === id ? { id, request, response } : exchange,
        ),
      );
      setChatContext((current) =>
        [
          current,
          `Asker: ${request.question}`,
          response.kind === "answer"
            ? `Librarian: ${response.answer}`
            : "Librarian: Insufficient information; question logged.",
        ]
          .filter(Boolean)
          .join("\n\n"),
      );
    } catch (error) {
      setExchanges((current) =>
        current.map((exchange) =>
          exchange.id === id
            ? {
                id,
                request,
                error:
                  error instanceof Error
                    ? error.message
                    : "The question could not be sent.",
              }
            : exchange,
        ),
      );
    }
  }

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    const text = question.trim();
    if (
      !text ||
      !selectedGoals.length ||
      busy ||
      !asker.trim() ||
      actorIdentity.status !== "configured"
    )
      return;
    const id = Date.now();
    const request: AskPayload = {
      question: text,
      goals: [...selectedGoals],
      asker: asker.trim(),
      ...(chatContext.trim() ? { chat: chatContext.trim() } : {}),
    };
    setExchanges((current) => [...current, { id, request, pending: true }]);
    setQuestion("");
    await sendExchange(id, request);
  }

  function retry(id: number) {
    if (busy) return;
    const exchange = exchanges.find((candidate) => candidate.id === id);
    if (!exchange?.error) return;
    setExchanges((current) =>
      current.map((candidate) =>
        candidate.id === id
          ? { id, request: candidate.request, pending: true }
          : candidate,
      ),
    );
    void sendExchange(id, exchange.request);
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  }

  return (
    <div className="ask-page">
      <PageHeader
        eyebrow="Librarian"
        title="Ask the documentation"
        description="Get a cited answer, or turn the exact gap into work for an expert—without losing the conversation that revealed it."
      />

      {exchanges.length === 0 ? (
        <section className="ask-intro" aria-labelledby="ask-intro-title">
          <div className="ask-orbit" aria-hidden="true">
            <span>
              <BookOpenText size={24} />
            </span>
            <span>
              <MessageCircleMore size={20} />
            </span>
            <span>
              <Lightbulb size={18} />
            </span>
            <Sparkles size={34} />
          </div>
          <h2 id="ask-intro-title">What do you need to know?</h2>
          <p>
            Choose what the answer needs to help you do. The Librarian checks
            each goal independently.
          </p>
          <div className="suggestion-row" aria-label="Example questions">
            {suggestedQuestions.map((suggestion) => (
              <button
                key={suggestion}
                className="suggestion"
                type="button"
                onClick={() => setQuestion(suggestion)}
              >
                {suggestion} <ChevronRight aria-hidden="true" size={15} />
              </button>
            ))}
          </div>
        </section>
      ) : (
        <section
          className="conversation"
          aria-label="Conversation"
          aria-live="polite"
        >
          {exchanges.map((exchange) => (
            <ExchangeView
              key={exchange.id}
              exchange={exchange}
              retry={() => retry(exchange.id)}
            />
          ))}
        </section>
      )}

      <section className="ask-composer" aria-label="Ask a question">
        {actorIdentity.status !== "configured" ? <ActorIdentityNotice /> : null}
        {goalsResource.loading && !goalsResource.data ? (
          <LoadingState label="Loading answer goals…" />
        ) : null}
        {goalsResource.error ? (
          <ErrorState
            error={goalsResource.error}
            retry={goalsResource.reload}
          />
        ) : null}
        <div className="goal-picker">
          <span className="field-label" id="goal-label">
            This answer should help me…
          </span>
          <div className="chip-row" role="group" aria-labelledby="goal-label">
            {goalChoices.map((goal) => {
              const selected = selectedGoals.includes(goal.id);
              return (
                <button
                  key={goal.id}
                  type="button"
                  className={`goal-chip${selected ? " selected" : ""}`}
                  aria-pressed={selected}
                  title={goal.description}
                  onClick={() => toggleGoal(goal.id)}
                >
                  {selected ? <Check aria-hidden="true" size={13} /> : null}
                  {goal.label}
                </button>
              );
            })}
            <label className="visually-hidden" htmlFor="custom-goal">
              Add a custom goal
            </label>
            <input
              id="custom-goal"
              className="goal-chip"
              value={customGoal}
              maxLength={96}
              placeholder="Another goal…"
              aria-describedby={
                customGoalError ? "custom-goal-error" : undefined
              }
              aria-invalid={customGoalError ? "true" : undefined}
              onChange={(event) => {
                setCustomGoal(event.target.value);
                if (customGoalError) setCustomGoalError("");
              }}
              onKeyDown={onCustomGoalKeyDown}
            />
            <button
              type="button"
              className="goal-chip"
              disabled={!customGoal.trim()}
              onClick={addCustomGoal}
            >
              Add goal
            </button>
          </div>
          {customGoalError ? (
            <p className="field-error" id="custom-goal-error" role="alert">
              {customGoalError}
            </p>
          ) : null}
          {!selectedGoals.length ? (
            <p className="field-error">
              Choose at least one goal so “answered” has a decisive meaning.
            </p>
          ) : null}
        </div>

        <form className="composer-box" onSubmit={(event) => void submit(event)}>
          <label className="visually-hidden" htmlFor="ask-question">
            Question
          </label>
          <textarea
            id="ask-question"
            rows={3}
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={onComposerKeyDown}
            placeholder="Ask a specific question…"
            disabled={busy}
          />
          <div className="composer-actions">
            <button
              className="context-toggle"
              type="button"
              aria-expanded={showContext}
              onClick={() => setShowContext((value) => !value)}
            >
              <MessageCircleMore aria-hidden="true" size={16} />{" "}
              {showContext ? "Hide provenance" : "Add conversation context"}
            </button>
            <Button
              className="send-button"
              type="submit"
              disabled={
                busy ||
                !question.trim() ||
                !selectedGoals.length ||
                !asker.trim() ||
                actorIdentity.status !== "configured"
              }
              aria-label="Ask the documentation"
            >
              {busy ? (
                <CircleDashed className="spin" aria-hidden="true" size={18} />
              ) : (
                <ArrowUp aria-hidden="true" size={18} />
              )}
            </Button>
          </div>
          {showContext ? (
            <div className="context-fields">
              <label>
                <span>Asker identity</span>
                <input
                  value={asker}
                  onChange={(event) => setAskerOverride(event.target.value)}
                  placeholder="Name or stable handle"
                />
                <small>
                  Defaults to your actor handle. Change it only when recording a
                  question for someone else.
                </small>
              </label>
              <label>
                <span>Relevant chat context</span>
                <textarea
                  rows={4}
                  value={chatContext}
                  onChange={(event) => setChatContext(event.target.value)}
                  placeholder="Paste only context that affects the question."
                />
              </label>
              <p>
                <FileText aria-hidden="true" size={14} /> If a gap is logged,
                the exact question and this context become immutable raw
                artifacts.
              </p>
            </div>
          ) : null}
        </form>
        <p className="composer-hint">
          Enter to send · Shift + Enter for a new line
        </p>
      </section>
    </div>
  );
}

function ExchangeView({
  exchange,
  retry,
}: {
  exchange: Exchange;
  retry: () => void;
}) {
  return (
    <article className="exchange">
      <div className="asker-message">
        <p>{exchange.request.question}</p>
        <div>
          {exchange.request.goals.map((goal) => (
            <span key={goal}>{goal}</span>
          ))}
        </div>
      </div>
      {exchange.pending ? (
        <div className="librarian-thinking" role="status">
          <span className="thinking-mark">
            <Sparkles size={17} />
          </span>
          <div>
            <strong>Librarian is checking the repository</strong>
            <span>
              Following maps, reading sources, and evaluating each goal…
            </span>
          </div>
        </div>
      ) : null}
      {exchange.error ? (
        <InlineNotice tone="danger" title="The Librarian could not finish">
          <p>
            {exchange.error} Your question remains in this browser until you
            retry it.
          </p>
          <Button type="button" variant="secondary" onClick={retry}>
            Retry question
          </Button>
        </InlineNotice>
      ) : null}
      {exchange.response?.kind === "answer" ? (
        <CitedAnswer response={exchange.response} />
      ) : null}
      {exchange.response?.kind === "logged" ? (
        <LoggedGap response={exchange.response} />
      ) : null}
    </article>
  );
}

function CitedAnswer({
  response,
}: {
  response: Extract<AskResponse, { kind: "answer" }>;
}) {
  return (
    <Card className="answer-card">
      <div className="answer-heading">
        <span>
          <Sparkles aria-hidden="true" size={18} />
        </span>
        <strong>Answer from the repository</strong>
      </div>
      <div className="prose-answer">
        {response.answer.split("\n").map((paragraph, index) => (
          <p key={`${index}-${paragraph.slice(0, 12)}`}>{paragraph}</p>
        ))}
      </div>
      {response.citations.length ? (
        <div className="citations">
          <h3>Sources</h3>
          <ol>
            {response.citations.map((citation, index) => (
              <li key={`${citation.path}-${index}`}>
                <span>{index + 1}</span>
                <div>
                  <strong>
                    {citation.title ?? citation.path.split("/").at(-1)}
                  </strong>
                  <code>
                    {citation.path}
                    {citation.line ? `:${citation.line}` : ""}
                  </code>
                  {citation.excerpt ? <p>{citation.excerpt}</p> : null}
                </div>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
      {response.goalResults.length ? (
        <div className="goal-results">
          <h3>Goal check</h3>
          {response.goalResults.map((result) => (
            <div key={result.goal}>
              <span>
                <strong>{result.goal}</strong>
                <small>{result.rationale}</small>
              </span>
              <GoalStatusBadge status={result.status} />
            </div>
          ))}
        </div>
      ) : null}
    </Card>
  );
}

function LoggedGap({
  response,
}: {
  response: Extract<AskResponse, { kind: "logged" }>;
}) {
  const { question } = response;
  return (
    <Card className="gap-card">
      <div className="gap-icon" aria-hidden="true">
        <CircleDashed size={22} />
      </div>
      <div className="gap-body">
        <p className="eyebrow">Knowledge gap captured</p>
        <h2>The repository can’t support this answer yet.</h2>
        <p>
          The exact ask, goals, and conversation context are saved under a
          stable ID. An answerer can now resolve the gap without guessing why it
          matters.
        </p>
        {response.partialAnswer ? (
          <div className="partial-answer">
            <h3>What the repository already establishes</h3>
            {response.partialAnswer.split("\n").map((paragraph, index) => (
              <p key={`${index}-${paragraph.slice(0, 12)}`}>{paragraph}</p>
            ))}
            {response.citations?.length ? (
              <ul aria-label="Partial answer sources">
                {response.citations.map((citation, index) => (
                  <li key={`${citation.path}-${index}`}>
                    <code>{citation.path}</code>
                    {citation.excerpt ? <span>{citation.excerpt}</span> : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
        <div className="gap-meta">
          <PriorityBadge tier={question.tier} />
          <code>{question.id}</code>
          <span>
            {question.goals.length} goal{question.goals.length === 1 ? "" : "s"}{" "}
            unsatisfied
          </span>
        </div>
        <Link className="button button-secondary" to={`/queue/${question.id}`}>
          View queue record <ChevronRight aria-hidden="true" size={16} />
        </Link>
      </div>
    </Card>
  );
}

const fallbackGoals: GoalDefinition[] = [
  {
    id: "documentation",
    label: "Understand it",
    description: "A clear explanation",
  },
  {
    id: "implementation",
    label: "Implement it",
    description: "Enough detail to build",
  },
  {
    id: "security-review",
    label: "Review security",
    description: "Threats and mitigations",
  },
];

function normaliseGoalTag(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase()
    .replace(/[’']/gu, "")
    .replace(/[^a-z0-9._:-]+/gu, "-")
    .replace(/^[._:-]+/gu, "")
    .slice(0, 96)
    .replace(/[._:-]+$/gu, "");
}
