import * as LabelPrimitive from "@radix-ui/react-label";
import {
  forwardRef,
  type InputHTMLAttributes,
  type LabelHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";

import { cn } from "@/lib/cn";

const fieldClasses =
  "w-full rounded-md border border-edge bg-surface-1 px-2.5 py-1.5 text-sm text-slate-200 placeholder:text-slate-500 transition-colors focus:border-accent/70 focus:outline-none focus:ring-1 focus:ring-accent/40 disabled:opacity-50";

export const Input = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement>
>(function Input({ className, ...props }, ref) {
  return <input ref={ref} className={cn(fieldClasses, "h-8", className)} {...props} />;
});

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, ...props }, ref) {
  return (
    <textarea
      ref={ref}
      className={cn(fieldClasses, "resize-y leading-relaxed", className)}
      {...props}
    />
  );
});

export const Label = forwardRef<
  HTMLLabelElement,
  LabelHTMLAttributes<HTMLLabelElement>
>(function Label({ className, ...props }, ref) {
  return (
    <LabelPrimitive.Root
      ref={ref}
      className={cn(
        "text-[11px] font-medium uppercase tracking-wide text-slate-400",
        className,
      )}
      {...props}
    />
  );
});
