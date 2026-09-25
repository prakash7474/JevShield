import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

export function Panel({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex h-full min-h-0 flex-col overflow-hidden bg-surface-0",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function PanelToolbar({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex shrink-0 flex-wrap items-center gap-2 border-b border-edge bg-surface-1/60 px-3 py-2",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function PanelBody({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("min-h-0 flex-1 overflow-auto", className)}>{children}</div>
  );
}

export function PanelSection({
  title,
  action,
  children,
  className,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("flex flex-col gap-2", className)}>
      <header className="flex items-center justify-between gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          {title}
        </h3>
        {action}
      </header>
      {children}
    </section>
  );
}

export function EmptyState({
  icon,
  title,
  hint,
  action,
}: {
  icon?: ReactNode;
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
      {icon ? <div className="text-slate-600">{icon}</div> : null}
      <p className="text-xs font-medium text-slate-400">{title}</p>
      {hint ? (
        <p className="max-w-sm text-[11px] leading-relaxed text-slate-600">
          {hint}
        </p>
      ) : null}
      {action}
    </div>
  );
}

export function FieldRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium uppercase tracking-wide text-slate-400">
        {label}
      </span>
      {children}
      {hint ? (
        <span className="text-[11px] leading-snug text-slate-600">{hint}</span>
      ) : null}
    </label>
  );
}

export function StatTile({
  label,
  value,
  tone = "neutral",
  hint,
}: {
  label: string;
  value: string;
  tone?: "neutral" | "ok" | "warn" | "danger" | "accent";
  hint?: string;
}) {
  const toneClass = {
    neutral: "text-slate-200",
    ok: "text-ok",
    warn: "text-warn",
    danger: "text-danger",
    accent: "text-accent",
  }[tone];

  return (
    <div className="flex flex-col gap-0.5 rounded border border-edge bg-surface-1 px-2.5 py-2">
      <span className="text-[10px] font-medium uppercase tracking-wide text-slate-500">
        {label}
      </span>
      <span className={cn("font-mono text-sm leading-tight", toneClass)}>
        {value}
      </span>
      {hint ? (
        <span className="text-[10px] text-slate-600">{hint}</span>
      ) : null}
    </div>
  );
}
