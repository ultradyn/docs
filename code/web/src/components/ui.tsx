import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  FileQuestion,
  LoaderCircle,
  RefreshCw,
  type LucideIcon,
} from "lucide-react";
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";

import { readableState } from "../model.js";
import type { GoalStatus, PriorityTier } from "../types.js";

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
        <h1>{title}</h1>
        <p className="page-description">{description}</p>
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </header>
  );
}

export function Button({
  className = "",
  variant = "primary",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "quiet" | "danger";
}) {
  return (
    <button
      className={`button button-${variant} ${className}`.trim()}
      {...props}
    />
  );
}

export function IconButton({
  label,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  children: ReactNode;
}) {
  return (
    <button className="icon-button" aria-label={label} title={label} {...props}>
      {children}
    </button>
  );
}

export function Card({
  className = "",
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return <div className={`card ${className}`.trim()} {...props} />;
}

export function StatusPill({
  tone = "neutral",
  children,
  icon: Icon,
}: {
  tone?: "neutral" | "positive" | "warning" | "danger" | "info";
  children: ReactNode;
  icon?: LucideIcon;
}) {
  return (
    <span className={`status-pill status-${tone}`}>
      {Icon ? <Icon aria-hidden="true" size={13} /> : null}
      {children}
    </span>
  );
}

export function PriorityBadge({ tier }: { tier: PriorityTier }) {
  return (
    <span className={`priority-badge priority-${tier.toLocaleLowerCase()}`}>
      {tier}
    </span>
  );
}

const goalStatusMap: Record<
  GoalStatus,
  {
    mark: string;
    tone: "positive" | "warning" | "danger" | "info";
    label: string;
  }
> = {
  satisfied: { mark: "✓", tone: "positive", label: "Satisfied" },
  unsatisfied: { mark: "×", tone: "danger", label: "Unsatisfied" },
  uncertain: { mark: "?", tone: "warning", label: "Uncertain" },
  deferred: { mark: "↳", tone: "info", label: "Deferred" },
  contradiction: { mark: "!", tone: "danger", label: "Contradiction" },
};

export function GoalStatusBadge({ status }: { status: GoalStatus }) {
  const item = goalStatusMap[status] ?? goalStatusMap.uncertain;
  return (
    <StatusPill tone={item.tone}>
      <span aria-hidden="true">{item.mark}</span> {item.label}
    </StatusPill>
  );
}

export function LoadingState({ label = "Loading" }: { label?: string }) {
  return (
    <div className="state-panel" role="status">
      <LoaderCircle className="spin" aria-hidden="true" size={24} />
      <p>{label}</p>
    </div>
  );
}

export function ErrorState({
  error,
  retry,
}: {
  error: Error;
  retry?: () => void;
}) {
  return (
    <div className="state-panel state-error" role="alert">
      <AlertCircle aria-hidden="true" size={26} />
      <div>
        <strong>We couldn’t load this</strong>
        <p>{error.message}</p>
      </div>
      {retry ? (
        <Button variant="secondary" onClick={retry}>
          <RefreshCw aria-hidden="true" size={16} /> Retry
        </Button>
      ) : null}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <FileQuestion aria-hidden="true" size={30} />
      <h2>{title}</h2>
      <p>{description}</p>
      {action}
    </div>
  );
}

export function InlineNotice({
  tone = "info",
  title,
  children,
}: {
  tone?: "info" | "positive" | "warning" | "danger";
  title: string;
  children: ReactNode;
}) {
  const Icon = tone === "positive" ? CheckCircle2 : AlertCircle;
  return (
    <div
      className={`inline-notice notice-${tone}`}
      role={tone === "danger" ? "alert" : "status"}
    >
      <Icon aria-hidden="true" size={18} />
      <div>
        <strong>{title}</strong>
        <div>{children}</div>
      </div>
    </div>
  );
}

export function StateText({ value }: { value: string }) {
  return <span className="state-text">{readableState(value)}</span>;
}

export function ActionLink({ children }: { children: ReactNode }) {
  return (
    <span className="action-link">
      {children} <ArrowRight aria-hidden="true" size={14} />
    </span>
  );
}
