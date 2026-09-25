import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";

import { cn } from "@/lib/cn";
import type { StageStatus } from "@/types";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
  {
    variants: {
      tone: {
        neutral: "border-edge bg-surface-2 text-slate-400",
        accent: "border-accent/40 bg-accent/10 text-accent",
        ok: "border-ok/40 bg-ok/10 text-ok",
        warn: "border-warn/40 bg-warn/10 text-warn",
        danger: "border-danger/40 bg-danger/10 text-danger",
        info: "border-info/40 bg-info/10 text-info",
        violet: "border-violet/40 bg-violet/10 text-violet",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

export function stageTone(status: StageStatus): NonNullable<BadgeProps["tone"]> {
  switch (status) {
    case "passed":
      return "ok";
    case "escalated":
      return "violet";
    case "warn":
      return "warn";
    case "blocked":
      return "danger";
    case "bypassed":
      return "neutral";
    case "pending":
      return "info";
    default:
      return "neutral";
  }
}
