import {
  AlertCircle,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  FileQuestion,
  LoaderCircle,
  RefreshCw,
  type LucideIcon,
} from "lucide-react";
import {
  type ButtonHTMLAttributes,
  type CSSProperties,
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

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

export interface ComboBoxOption<T extends string = string> {
  value: T;
  label: string;
}

export function ComboBox<T extends string>({
  id,
  label,
  value,
  options,
  onChange,
  className = "",
  describedBy,
  disabled = false,
  required = false,
}: {
  id?: string;
  label: string;
  value: T;
  options: readonly ComboBoxOption<T>[];
  onChange: (value: T) => void;
  className?: string;
  describedBy?: string;
  disabled?: boolean;
  required?: boolean;
}) {
  const generatedId = useId();
  const listboxId = `${id ?? `combo-box-${generatedId}`}-options`;
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listboxRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>();
  const selectedIndex = options.findIndex((option) => option.value === value);
  const selected = options[selectedIndex];

  function placeMenu() {
    const trigger = triggerRef.current;
    if (!trigger || typeof window === "undefined") return;
    const rect = trigger.getBoundingClientRect();
    const expectedHeight = Math.min(options.length * 36 + 8, 280);
    const below = window.innerHeight - rect.bottom - 12;
    const above = rect.top - 12;
    const placeBelow = below >= Math.min(expectedHeight, 160) || below >= above;
    setMenuStyle({
      left: Math.max(
        8,
        Math.min(rect.left, window.innerWidth - Math.max(rect.width, 160) - 8),
      ),
      width: Math.max(rect.width, 160),
      maxHeight: Math.max(96, Math.min(280, placeBelow ? below : above)),
      ...(placeBelow
        ? { top: rect.bottom + 6 }
        : { bottom: window.innerHeight - rect.top + 6 }),
    });
  }

  function openMenu(index = selectedIndex >= 0 ? selectedIndex : 0) {
    if (disabled || !options.length) return;
    placeMenu();
    setActiveIndex(index);
    setOpen(true);
  }

  function closeMenu() {
    setOpen(false);
    setActiveIndex(-1);
  }

  function choose(index: number) {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    closeMenu();
    window.setTimeout(() => triggerRef.current?.focus(), 0);
  }

  function moveActive(delta: number) {
    if (!options.length) return;
    const start = activeIndex >= 0 ? activeIndex : selectedIndex;
    setActiveIndex((start + delta + options.length) % options.length);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "Tab" && open) {
      closeMenu();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) openMenu();
      else moveActive(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      if (!open) openMenu(event.key === "Home" ? 0 : options.length - 1);
      else setActiveIndex(event.key === "Home" ? 0 : options.length - 1);
      return;
    }
    if (event.key === "Escape" && open) {
      event.preventDefault();
      closeMenu();
      return;
    }
    if ((event.key === "Enter" || event.key === " ") && open) {
      event.preventDefault();
      choose(activeIndex);
      return;
    }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey) {
      const match = options.findIndex((option) =>
        option.label
          .toLocaleLowerCase()
          .startsWith(event.key.toLocaleLowerCase()),
      );
      if (match >= 0) {
        event.preventDefault();
        if (!open) openMenu(match);
        else setActiveIndex(match);
      }
    }
  }

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !rootRef.current?.contains(target) &&
        !listboxRef.current?.contains(target)
      )
        closeMenu();
    };
    const closeOnViewportChange = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && listboxRef.current?.contains(target))
        return;
      closeMenu();
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer, true);
    window.addEventListener("resize", closeOnViewportChange);
    window.addEventListener("scroll", closeOnViewportChange, true);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer, true);
      window.removeEventListener("resize", closeOnViewportChange);
      window.removeEventListener("scroll", closeOnViewportChange, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open || activeIndex < 0) return;
    document
      .getElementById(`${listboxId}-option-${activeIndex}`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, listboxId, open]);

  return (
    <div ref={rootRef} className={`combo-box ${className}`.trim()}>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        className="combo-box-trigger"
        role="combobox"
        aria-label={label}
        aria-controls={listboxId}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-activedescendant={
          open && activeIndex >= 0
            ? `${listboxId}-option-${activeIndex}`
            : undefined
        }
        aria-describedby={describedBy}
        aria-required={required || undefined}
        disabled={disabled}
        onClick={() => (open ? closeMenu() : openMenu())}
        onKeyDown={handleKeyDown}
      >
        <span className="combo-box-value">
          {selected?.label ?? "Choose an option"}
        </span>
        <ChevronDown aria-hidden="true" size={15} />
      </button>
      {open && menuStyle && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={listboxRef}
              id={listboxId}
              className="combo-box-menu"
              role="listbox"
              aria-label={`${label} options`}
              style={menuStyle}
            >
              {options.map((option, index) => (
                <div
                  id={`${listboxId}-option-${index}`}
                  className="combo-box-option"
                  role="option"
                  aria-selected={option.value === value}
                  data-active={index === activeIndex || undefined}
                  key={option.value}
                  onMouseMove={() => setActiveIndex(index)}
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => choose(index)}
                >
                  <span>{option.label}</span>
                  {option.value === value ? (
                    <Check aria-hidden="true" size={15} />
                  ) : null}
                </div>
              ))}
            </div>,
            document.body,
          )
        : null}
    </div>
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
