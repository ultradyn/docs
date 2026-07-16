import {
  ArrowRight,
  AudioLines,
  CheckCircle2,
  CircleDashed,
  CircleStop,
  FileDiff,
  GitBranch,
  ListTree,
  Mic2,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Save,
  Sparkles,
  WandSparkles,
} from "lucide-react";
import { useCallback, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { useActorIdentity, useApi } from "../api-context.js";
import { normaliseQuestion, recorderLabel, sortQuestions } from "../model.js";
import { useAsyncResource, useDocumentTitle } from "../hooks.js";
import type { Finding, Question } from "../types.js";
import { useAudioCapture } from "../useAudioCapture.js";
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  GoalStatusBadge,
  InlineNotice,
  LoadingState,
  PageHeader,
  PriorityBadge,
  StateText,
  StatusPill,
} from "../components/ui.js";
import { ActorIdentityNotice } from "../components/ActorIdentityNotice.js";

export function AnswerPage() {
  useDocumentTitle("Answer");
  const { questionId } = useParams();
  if (!questionId) return <AnswerPicker />;
  return <AnswerSession questionId={questionId} />;
}

function AnswerPicker() {
  const { api } = useApi();
  const actorIdentity = useActorIdentity();
  const navigate = useNavigate();
  const [opening, setOpening] = useState<string>();
  const [openError, setOpenError] = useState<string>();
  const questions = useAsyncResource(
    () => api.questions({ bucket: "active" }),
    [api],
  );
  const ready = sortQuestions(questions.data ?? []).filter((question) =>
    ["active", "reopened", "in-answer"].includes(question.state),
  );

  async function openAnswer(question: Question) {
    if (opening) return;
    if (question.state !== "in-answer" && actorIdentity.status !== "configured")
      return;
    setOpening(question.id);
    setOpenError(undefined);
    try {
      if (question.state !== "in-answer") {
        if (actorIdentity.status !== "configured") return;
        await api.claim(question.id, actorIdentity.handle);
      }
      navigate(`/answer/${question.id}`);
    } catch (caught) {
      setOpenError(
        caught instanceof Error
          ? caught.message
          : "Question could not be claimed.",
      );
      setOpening(undefined);
    }
  }
  return (
    <div className="answer-picker-page">
      <PageHeader
        eyebrow="Expert capture"
        title="Choose something to answer"
        description="Start with the highest-impact question you can resolve. The interface keeps formatting and integration work out of your way."
      />
      {actorIdentity.status !== "configured" ? <ActorIdentityNotice /> : null}
      {questions.loading && !questions.data ? (
        <LoadingState label="Finding answerable questions…" />
      ) : null}
      {questions.error ? (
        <ErrorState error={questions.error} retry={questions.reload} />
      ) : null}
      {!questions.loading && !questions.error && !ready.length ? (
        <EmptyState
          title="The active queue is clear"
          description="New knowledge gaps will appear here after the Librarian logs them."
          action={
            <Link className="button button-secondary" to="/queue">
              Open the full queue
            </Link>
          }
        />
      ) : null}
      {openError ? (
        <p className="field-error" role="alert">
          {openError}
        </p>
      ) : null}
      <div className="answer-picker-grid">
        {ready.map((question) => (
          <button
            type="button"
            className="answer-pick-card"
            key={question.id}
            disabled={
              Boolean(opening) ||
              (question.state !== "in-answer" &&
                actorIdentity.status !== "configured")
            }
            onClick={() => void openAnswer(question)}
          >
            <div>
              <PriorityBadge tier={question.tier} />
              <StateText value={question.state} />
            </div>
            <h2>{question.title}</h2>
            <p>{question.question}</p>
            <span>
              {opening === question.id ? "Claiming…" : "Open answer room"}{" "}
              <ArrowRight aria-hidden="true" size={15} />
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function AnswerSession({ questionId }: { questionId: string }) {
  const { api, runtime, latestEvent } = useApi();
  const actorIdentity = useActorIdentity();
  const resource = useAsyncResource(
    () => api.question(questionId),
    [api, questionId],
  );
  const [typedText, setTypedText] = useState("");
  const [liveTranscript, setLiveTranscript] = useState("");
  const [findings, setFindings] = useState<Finding[]>();
  const [rejectionReason, setRejectionReason] = useState("");
  const [action, setAction] = useState<string>();
  const [notice, setNotice] = useState<{
    tone: "positive" | "danger" | "info";
    title: string;
    text: string;
  }>();

  const saveSttTranscript = useCallback(
    async (transcript: string) => {
      await api.addTranscript(questionId, transcript, "stt");
      setLiveTranscript("");
      resource.reload();
    },
    [api, questionId, resource],
  );
  const audio = useAudioCapture({
    api,
    questionId,
    onTranscript: saveSttTranscript,
  });

  const partial =
    latestEvent?.type === "transcript.partial" &&
    latestEvent.questionId === questionId
      ? latestEvent.text
      : undefined;
  const question = resource.data;
  const hasAnswerClaim = question?.state === "in-answer";
  const canCapture = hasAnswerClaim && actorIdentity.status === "configured";
  const canClaim =
    question?.state === "active" || question?.state === "reopened";
  const pendingAskers =
    question?.askers?.filter(
      (asker) =>
        !asker.status ||
        asker.status === "pending" ||
        asker.status === "waiting",
    ) ?? [];
  const matchingPendingAsker =
    actorIdentity.status === "configured"
      ? pendingAskers.find(
          (asker) => (asker.id ?? asker.name) === actorIdentity.handle,
        )
      : undefined;
  const currentFindings = findings ?? question?.findings ?? [];
  const hasContradiction = currentFindings.some(
    (finding) => finding.status === "contradiction",
  );
  const criticDone =
    currentFindings.length > 0 &&
    currentFindings.every(
      (finding) =>
        finding.status === "satisfied" || finding.status === "deferred",
    );
  const deferred = currentFindings.filter(
    (finding) => finding.status === "deferred" || finding.childQuestionId,
  );

  async function saveTyped() {
    const text = typedText.trim();
    if (!text || action) return;
    setAction("save");
    setNotice(undefined);
    try {
      await api.addTranscript(
        questionId,
        text,
        "typed",
        undefined,
        "correction",
      );
      setTypedText("");
      setNotice({
        tone: "positive",
        title: "Correction appended",
        text: "A new immutable raw artifact was created. Earlier transcripts were not edited.",
      });
      resource.reload();
    } catch (caught) {
      setNotice({
        tone: "danger",
        title: "Correction not saved",
        text: caught instanceof Error ? caught.message : "Try again.",
      });
    } finally {
      setAction(undefined);
    }
  }

  async function claimQuestion() {
    if (
      !question ||
      !canClaim ||
      action ||
      actorIdentity.status !== "configured"
    )
      return;
    setAction("claim");
    setNotice(undefined);
    try {
      await api.claim(question.id, actorIdentity.handle);
      setNotice({
        tone: "positive",
        title: "Question claimed",
        text: "Recording and append-only answer capture are now available.",
      });
      resource.reload();
    } catch (caught) {
      setNotice({
        tone: "danger",
        title: "Question could not be claimed",
        text: caught instanceof Error ? caught.message : "Try again.",
      });
    } finally {
      setAction(undefined);
    }
  }

  async function runStructure() {
    setAction("structure");
    setNotice(undefined);
    try {
      await api.questionAction(questionId, "structure");
      setNotice({
        tone: "positive",
        title: "Structured draft refreshed",
        text: "The draft was rebuilt from every immutable transcript and correction.",
      });
      resource.reload();
    } catch (caught) {
      setNotice({
        tone: "danger",
        title: "Structurer could not finish",
        text: caught instanceof Error ? caught.message : "Try again.",
      });
    } finally {
      setAction(undefined);
    }
  }

  async function runCritic() {
    setAction("critic");
    setNotice(undefined);
    try {
      const response = await api.questionAction<unknown>(questionId, "critic");
      setFindings(normaliseQuestion(response).findings ?? []);
      setNotice({
        tone: "positive",
        title: "Fresh critic round complete",
        text: "Each declared goal was evaluated in a new provider context.",
      });
      resource.reload();
    } catch (caught) {
      setNotice({
        tone: "danger",
        title: "Critic could not finish",
        text: caught instanceof Error ? caught.message : "Try again.",
      });
    } finally {
      setAction(undefined);
    }
  }

  async function integrate() {
    if (!criticDone) return;
    setAction("integrate");
    setNotice(undefined);
    try {
      await api.questionAction(questionId, "integrate");
      setNotice({
        tone: "positive",
        title: "Local change request started",
        text: "Workers are preparing an isolated branch and actual documentation diff.",
      });
      resource.reload();
    } catch (caught) {
      setNotice({
        tone: "danger",
        title: "Integration could not start",
        text: caught instanceof Error ? caught.message : "Try again.",
      });
    } finally {
      setAction(undefined);
    }
  }

  async function approveChangeRequest() {
    if (actorIdentity.status !== "configured") return;
    setAction("approve-change");
    setNotice(undefined);
    try {
      await api.changeRequestAction(questionId, "approve", {
        by: actorIdentity.handle,
        kind: "answerer",
      });
      setNotice({
        tone: "positive",
        title: "Change explicitly approved",
        text: "The approval is recorded. The local branch can now be merged.",
      });
      resource.reload();
    } catch (caught) {
      setNotice({
        tone: "danger",
        title: "Approval was not recorded",
        text: caught instanceof Error ? caught.message : "Try again.",
      });
    } finally {
      setAction(undefined);
    }
  }

  async function mergeChangeRequest() {
    if (actorIdentity.status !== "configured") return;
    setAction("merge-change");
    setNotice(undefined);
    try {
      await api.changeRequestAction(questionId, "merge", {
        by: actorIdentity.handle,
      });
      setNotice({
        tone: "positive",
        title: "Documentation merged locally",
        text: "The reviewed branch is now in the checked-out documentation. The asker can accept or reject it.",
      });
      resource.reload();
    } catch (caught) {
      setNotice({
        tone: "danger",
        title: "Merge needs attention",
        text: caught instanceof Error ? caught.message : "Try again.",
      });
    } finally {
      setAction(undefined);
    }
  }

  async function decideAnswer(decision: "accept" | "reject") {
    if (decision === "reject" && !rejectionReason.trim()) return;
    const asker = matchingPendingAsker?.id ?? matchingPendingAsker?.name;
    if (!asker) {
      setNotice({
        tone: "danger",
        title: "No pending asker",
        text: "Every recorded asker has already decided this answer.",
      });
      return;
    }
    setAction(decision);
    setNotice(undefined);
    try {
      await api.questionAction(
        questionId,
        decision,
        decision === "accept"
          ? { asker }
          : { asker, reason: rejectionReason.trim() },
      );
      setRejectionReason("");
      setNotice(
        decision === "accept"
          ? {
              tone: "positive",
              title: "Answer accepted",
              text: "The question and its provenance moved to the answered queue.",
            }
          : {
              tone: "info",
              title: "Question reopened at P1",
              text: "The verbatim rejection reason was appended as an immutable artifact.",
            },
      );
      resource.reload();
    } catch (caught) {
      setNotice({
        tone: "danger",
        title: "Decision was not recorded",
        text: caught instanceof Error ? caught.message : "Try again.",
      });
    } finally {
      setAction(undefined);
    }
  }

  async function simulateTranscript() {
    setAction("simulate");
    try {
      await api.addTranscript(
        questionId,
        "A deterministic fake transcript segment: explain the lifecycle, trust boundary, recovery point, and operator responsibility.",
        "stt",
        0.99,
      );
      setNotice({
        tone: "info",
        title: "Fake STT segment appended",
        text: "This exercised the same immutable transcript API without using a microphone or external provider.",
      });
      resource.reload();
    } catch (caught) {
      setNotice({
        tone: "danger",
        title: "Fake transcript failed",
        text: caught instanceof Error ? caught.message : "Try again.",
      });
    } finally {
      setAction(undefined);
    }
  }

  if (resource.loading && !question)
    return <LoadingState label="Preparing the answer room…" />;
  if (resource.error)
    return <ErrorState error={resource.error} retry={resource.reload} />;
  if (!question)
    return (
      <EmptyState
        title="Question unavailable"
        description="Return to the queue and choose an active question."
        action={
          <Link className="button button-secondary" to="/queue">
            Open queue
          </Link>
        }
      />
    );

  return (
    <div className="answer-session-page">
      <PageHeader
        eyebrow={`${question.tier} · ${question.id}`}
        title={question.title}
        description={question.question}
        actions={
          <div className="header-statuses">
            <StateText value={question.state} />
            <StatusPill
              tone={
                criticDone
                  ? "positive"
                  : hasContradiction
                    ? "danger"
                    : "warning"
              }
            >
              {criticDone
                ? "Critic done"
                : hasContradiction
                  ? "Blocked by contradiction"
                  : "Evaluation open"}
            </StatusPill>
          </div>
        }
      />
      <ProgressRail
        question={question}
        hasTranscript={Boolean(question.transcript)}
        hasFindings={currentFindings.length > 0}
        criticDone={criticDone}
      />
      {notice ? (
        <InlineNotice tone={notice.tone} title={notice.title}>
          <p>{notice.text}</p>
        </InlineNotice>
      ) : null}
      {!hasAnswerClaim ? (
        <InlineNotice
          tone={canClaim ? "info" : "danger"}
          title={canClaim ? "Claim required" : "Capture unavailable"}
        >
          <p>
            {canClaim
              ? "Claim this question before recording audio or appending raw answer artifacts."
              : `Questions in the ${question.state} state cannot start a new capture session.`}
          </p>
          {canClaim ? (
            actorIdentity.status === "configured" ? (
              <Button
                disabled={Boolean(action)}
                onClick={() => void claimQuestion()}
              >
                <Mic2 aria-hidden="true" size={17} /> Claim question
              </Button>
            ) : null
          ) : null}
        </InlineNotice>
      ) : null}
      {canClaim && actorIdentity.status !== "configured" ? (
        <ActorIdentityNotice />
      ) : null}
      {hasAnswerClaim && actorIdentity.status !== "configured" ? (
        <ActorIdentityNotice />
      ) : null}

      <div className="answer-layout">
        <div className="answer-main-column">
          <Card className={`recorder-card recorder-${audio.state}`}>
            <div className="recorder-head">
              <div>
                <p className="eyebrow">Raw capture</p>
                <h2>Talk through the answer</h2>
              </div>
              <StatusPill
                tone={
                  audio.state === "recording"
                    ? "danger"
                    : audio.state === "failed"
                      ? "warning"
                      : audio.state === "complete"
                        ? "positive"
                        : "neutral"
                }
              >
                {recorderLabel(audio.state)}
              </StatusPill>
            </div>
            <div className="recorder-stage">
              <div className={`record-orb ${audio.state}`} aria-hidden="true">
                <Mic2 size={30} />
                <span />
                <span />
              </div>
              <div className="recorder-time" aria-live="polite">
                <strong>{formatDuration(audio.elapsedSeconds)}</strong>
                <span>
                  {audio.uploadedChunks} chunk
                  {audio.uploadedChunks === 1 ? "" : "s"} safely acknowledged
                  {audio.pendingChunks
                    ? ` · ${audio.pendingChunks} pending`
                    : ""}
                </span>
              </div>
              <div className="recorder-controls">
                {canCapture &&
                (audio.state === "idle" || audio.state === "complete") ? (
                  <Button onClick={() => void audio.start()}>
                    <Mic2 aria-hidden="true" size={17} />{" "}
                    {audio.state === "complete"
                      ? "Record another segment"
                      : "Start recording"}
                  </Button>
                ) : null}
                {audio.state === "recording" ? (
                  <>
                    <Button variant="secondary" onClick={audio.pause}>
                      <Pause aria-hidden="true" size={17} /> Pause
                    </Button>
                    <Button variant="danger" onClick={audio.stop}>
                      <CircleStop aria-hidden="true" size={17} /> Finish
                    </Button>
                  </>
                ) : null}
                {audio.state === "paused" ? (
                  <>
                    <Button onClick={audio.resume}>
                      <Play aria-hidden="true" size={17} /> Resume
                    </Button>
                    <Button variant="secondary" onClick={audio.stop}>
                      <CircleStop aria-hidden="true" size={17} /> Finish
                    </Button>
                  </>
                ) : null}
                {audio.state === "failed" &&
                (audio.pendingChunks || audio.retryableOperation) ? (
                  <Button onClick={() => void audio.retry()}>
                    <RotateCcw aria-hidden="true" size={17} />{" "}
                    {audio.retryableOperation === "finalization"
                      ? "Retry finalization"
                      : "Retry upload"}
                  </Button>
                ) : null}
                {canCapture &&
                runtime.demoMode &&
                audio.state !== "recording" &&
                audio.state !== "finalising" ? (
                  <Button
                    variant="quiet"
                    disabled={Boolean(action)}
                    onClick={() => void simulateTranscript()}
                  >
                    <Sparkles aria-hidden="true" size={16} /> Simulate STT
                  </Button>
                ) : null}
              </div>
            </div>
            {audio.error ? (
              <p className="recorder-error" role="alert">
                {audio.error}{" "}
                {audio.pendingChunks
                  ? "Pending chunks remain in this page for retry."
                  : ""}
              </p>
            ) : null}
            <p className="recorder-safety">
              Audio is uploaded in order while you speak. Finalize verifies
              every chunk before conversion; raw chunks are removed only after
              the converted file is verified.
            </p>
          </Card>

          <Card className="transcript-card">
            <div className="section-heading">
              <div>
                <AudioLines aria-hidden="true" size={18} />
                <div>
                  <h2>Transcript</h2>
                  <p>Immutable segments plus append-only corrections</p>
                </div>
              </div>
              <StatusPill tone={partial ? "info" : "neutral"}>
                {partial ? "Receiving live text" : "Caught up"}
              </StatusPill>
            </div>
            <div className="transcript-paper">
              {question.transcript ? (
                <p>{question.transcript}</p>
              ) : (
                <p className="placeholder-copy">
                  Your durable transcript will appear here after the first
                  segment is finalized.
                </p>
              )}
              {partial || liveTranscript ? (
                <p className="live-transcript">
                  <span>Live</span>
                  {partial ?? liveTranscript}
                  <i aria-hidden="true" />
                </p>
              ) : null}
            </div>
            <div className="correction-box">
              <label htmlFor="typed-correction">
                Add dictation or a correction
              </label>
              <textarea
                id="typed-correction"
                rows={4}
                value={typedText}
                onChange={(event) => setTypedText(event.target.value)}
                placeholder="Type an additional verbatim segment. This appends; it never rewrites prior raw text."
              />
              <div>
                <p>
                  <Plus aria-hidden="true" size={14} /> Saved as a new raw
                  artifact
                </p>
                <Button
                  variant="secondary"
                  disabled={!canCapture || !typedText.trim() || Boolean(action)}
                  onClick={() => void saveTyped()}
                >
                  <Save aria-hidden="true" size={16} /> Append segment
                </Button>
              </div>
            </div>
          </Card>

          <Card className="structured-card">
            <div className="section-heading">
              <div>
                <WandSparkles aria-hidden="true" size={18} />
                <div>
                  <h2>Structured answer</h2>
                  <p>Derived and rebuildable from raw artifacts</p>
                </div>
              </div>
              <Button
                variant="secondary"
                disabled={!question.transcript || Boolean(action)}
                onClick={() => void runStructure()}
              >
                {action === "structure" ? (
                  <CircleDashed className="spin" size={16} />
                ) : (
                  <WandSparkles size={16} />
                )}{" "}
                Refresh draft
              </Button>
            </div>
            {question.structuredAnswer ? (
              <div className="structured-copy">
                <p>{question.structuredAnswer}</p>
              </div>
            ) : (
              <div className="structured-empty">
                <ListTree aria-hidden="true" size={25} />
                <p>
                  Capture a transcript, then ask the Structurer to shape it. You
                  only review the result.
                </p>
              </div>
            )}
          </Card>
        </div>

        <aside className="critic-column">
          <Card className="critic-card">
            <div className="critic-heading">
              <span>
                <Sparkles aria-hidden="true" size={18} />
              </span>
              <div>
                <h2>Critic goal matrix</h2>
                <p>Fresh context on every round</p>
              </div>
            </div>
            {!currentFindings.length ? (
              <div className="critic-empty">
                <p>
                  No critic round yet. Structure the answer, then evaluate every
                  declared goal.
                </p>
              </div>
            ) : (
              <div className="goal-matrix">
                {question.goals.map((goal) => {
                  const finding = currentFindings.find(
                    (item) => item.goal === goal,
                  );
                  return (
                    <div className="goal-matrix-row" key={goal}>
                      <div>
                        <strong>{goal}</strong>
                        <p>
                          {finding?.rationale ??
                            "This goal was not returned by the critic."}
                        </p>
                      </div>
                      <GoalStatusBadge
                        status={finding?.status ?? "uncertain"}
                      />
                    </div>
                  );
                })}
              </div>
            )}
            <Button
              className="critic-button"
              variant="secondary"
              disabled={!question.structuredAnswer || Boolean(action)}
              onClick={() => void runCritic()}
            >
              {action === "critic" ? (
                <CircleDashed className="spin" size={16} />
              ) : (
                <Sparkles size={16} />
              )}{" "}
              Run fresh critic
            </Button>
            {hasContradiction ? (
              <InlineNotice
                tone="danger"
                title="Contradiction blocks integration"
              >
                <p>
                  Resolve the conflicting documentation. Contradiction children
                  enter the active queue at P1.
                </p>
              </InlineNotice>
            ) : null}
          </Card>

          <Card className="deferred-card">
            <div className="section-heading">
              <div>
                <ListTree aria-hidden="true" size={18} />
                <div>
                  <h2>Deferred children</h2>
                  <p>Useful depth, kept nonblocking</p>
                </div>
              </div>
              <span className="count-bubble">{deferred.length}</span>
            </div>
            {!deferred.length ? (
              <p className="placeholder-copy">
                Ordinary missing depth will appear here with parent, finding,
                and goal provenance.
              </p>
            ) : (
              deferred.map((finding) => (
                <div
                  className="deferred-row"
                  key={finding.id ?? `${finding.goal}-${finding.rationale}`}
                >
                  <div>
                    <strong>
                      {finding.question ?? `More detail for ${finding.goal}`}
                    </strong>
                    <p>{finding.rationale}</p>
                  </div>
                  {finding.childQuestionId ? (
                    <Link to={`/queue/${finding.childQuestionId}`}>
                      {finding.childQuestionId}
                    </Link>
                  ) : (
                    <StatusPill tone="info">Will register</StatusPill>
                  )}
                </div>
              ))
            )}
          </Card>

          <Card className="integration-card">
            <div className="integration-icon">
              <FileDiff aria-hidden="true" size={22} />
            </div>
            <h2>Prepare documentation change</h2>
            <p>
              Integration creates an isolated{" "}
              <code>ultradyn/{question.id}</code> branch, then independent
              reviewers see the actual diff.
            </p>
            <div className="check-list">
              <span className={criticDone ? "done" : ""}>
                {criticDone ? (
                  <CheckCircle2 size={15} />
                ) : (
                  <CircleDashed size={15} />
                )}{" "}
                Critic goals decisive
              </span>
              <span>
                <GitBranch size={15} /> Local change request always available
              </span>
            </div>
            <Button
              disabled={
                !criticDone ||
                Boolean(action) ||
                Boolean(question.changeRequest)
              }
              onClick={() => void integrate()}
            >
              {action === "integrate" ? (
                <CircleDashed className="spin" size={16} />
              ) : (
                <FileDiff size={16} />
              )}{" "}
              {question.changeRequest
                ? "Integration started"
                : "Start integration"}
            </Button>
          </Card>

          {question.changeRequest ? (
            <Card className="change-request-card">
              <div className="section-heading">
                <div>
                  <GitBranch aria-hidden="true" size={18} />
                  <div>
                    <h2>Local change request</h2>
                    <p>{question.changeRequest.branch}</p>
                  </div>
                </div>
                <StatusPill
                  tone={
                    question.changeRequest.state === "blocked"
                      ? "danger"
                      : question.changeRequest.state === "merged"
                        ? "positive"
                        : "info"
                  }
                >
                  {question.changeRequest.state}
                </StatusPill>
              </div>
              <p>{question.changeRequest.summary}</p>
              <div className="change-checks">
                {question.changeRequest.checks.map((check) => (
                  <div key={check.id} className={check.status}>
                    {check.status === "passed" ? (
                      <CheckCircle2 aria-hidden="true" size={16} />
                    ) : (
                      <CircleDashed aria-hidden="true" size={16} />
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
                <pre>{question.changeRequest.diff}</pre>
              </details>
              {question.changeRequest.state === "open" ? (
                <Button
                  disabled={
                    Boolean(action) ||
                    actorIdentity.status !== "configured" ||
                    question.changeRequest.checks.some(
                      (check) => check.status === "failed",
                    )
                  }
                  onClick={() => void approveChangeRequest()}
                >
                  {action === "approve-change" ? (
                    <CircleDashed className="spin" size={16} />
                  ) : (
                    <CheckCircle2 size={16} />
                  )}{" "}
                  Approve change
                </Button>
              ) : null}
              {question.changeRequest.state === "approved" ? (
                <Button
                  disabled={
                    Boolean(action) || actorIdentity.status !== "configured"
                  }
                  onClick={() => void mergeChangeRequest()}
                >
                  {action === "merge-change" ? (
                    <CircleDashed className="spin" size={16} />
                  ) : (
                    <GitBranch size={16} />
                  )}{" "}
                  Merge locally
                </Button>
              ) : null}
              {["open", "approved"].includes(question.changeRequest.state) &&
              actorIdentity.status !== "configured" ? (
                <ActorIdentityNotice />
              ) : null}
              {question.changeRequest.state === "merged" &&
              question.state === "merged" &&
              matchingPendingAsker ? (
                <div className="asker-decision">
                  <h3>Did this answer the original question?</h3>
                  <Button
                    disabled={Boolean(action)}
                    onClick={() => void decideAnswer("accept")}
                  >
                    <CheckCircle2 size={16} /> Accept answer
                  </Button>
                  <label>
                    <span>Or explain exactly what is still missing</span>
                    <textarea
                      rows={3}
                      value={rejectionReason}
                      onChange={(event) =>
                        setRejectionReason(event.target.value)
                      }
                    />
                  </label>
                  <Button
                    variant="danger"
                    disabled={Boolean(action) || !rejectionReason.trim()}
                    onClick={() => void decideAnswer("reject")}
                  >
                    <RotateCcw size={16} /> Reject and reopen
                  </Button>
                </div>
              ) : question.changeRequest.state === "merged" &&
                question.state === "merged" &&
                pendingAskers.length ? (
                <ActorIdentityNotice
                  waitingFor={pendingAskers
                    .map((asker) => asker.name)
                    .join(", ")}
                />
              ) : null}
            </Card>
          ) : null}
        </aside>
      </div>
    </div>
  );
}

function ProgressRail({
  question,
  hasTranscript,
  hasFindings,
  criticDone,
}: {
  question: Question;
  hasTranscript: boolean;
  hasFindings: boolean;
  criticDone: boolean;
}) {
  const integrating = ["integrating", "merged", "accepted"].includes(
    question.state,
  );
  const steps = [
    { label: "Capture", done: hasTranscript },
    { label: "Structure", done: Boolean(question.structuredAnswer) },
    { label: "Critic", done: criticDone, active: hasFindings && !criticDone },
    { label: "Integrate", done: integrating },
  ];
  return (
    <ol className="progress-rail" aria-label="Answer progress">
      {steps.map((step, index) => (
        <li
          key={step.label}
          className={`${step.done ? "done" : ""}${step.active ? " active" : ""}`}
        >
          <span>{step.done ? <CheckCircle2 size={15} /> : index + 1}</span>
          <strong>{step.label}</strong>
        </li>
      ))}
    </ol>
  );
}

function formatDuration(seconds: number): string {
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}
