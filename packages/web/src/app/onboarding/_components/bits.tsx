"use client";

import { ChevronRightIcon, Loader2Icon } from "lucide-react";
import { cn } from "@/lib/utils";

// Small shared pieces for the onboarding steps. The palette is scoped here
// (hardcoded light values from the design) so onboarding always renders light
// regardless of the app theme — nothing reads the shadcn theme tokens.

// Serif headline family — the Fraunces variable is set on the page root
// (next/font/google in page.tsx), so this class only resolves inside the
// onboarding tree.
export const serif = "[font-family:var(--font-fraunces),Georgia,serif]";

export const STEP_COUNT = 5;

export function Dots({ step, className }: { step: number; className?: string }) {
  return (
    <div className={cn("flex items-center gap-2", className)} aria-label={`Step ${step + 1} of ${STEP_COUNT}`}>
      {Array.from({ length: STEP_COUNT }, (_, i) => (
        <span
          key={i}
          className={cn(
            "rounded-full",
            i === step ? "size-[9px] bg-[#1A1A1A]" : "size-2 bg-[#E8E8E1]"
          )}
          aria-hidden
        />
      ))}
    </div>
  );
}

// Black pill CTA ("Let's get started →", "Continue →", "Add N tasks →").
export function PrimaryPill({
  children,
  onClick,
  disabled,
  pending,
  className
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  pending?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || pending}
      className={cn(
        "inline-flex items-center justify-center gap-1.5 rounded-full bg-[#1C1C1A] px-6 py-3 text-[15px] font-semibold text-white transition-opacity hover:opacity-90 disabled:pointer-events-none disabled:opacity-50",
        className
      )}
    >
      {children}
      {pending ? (
        <Loader2Icon className="size-[18px] animate-spin" aria-hidden />
      ) : (
        <ChevronRightIcon className="size-[18px]" aria-hidden />
      )}
    </button>
  );
}

// Light pill secondary action ("Skip", "Skip for now", "+ Add account").
export function LightPill({
  children,
  onClick,
  disabled,
  className
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "inline-flex items-center justify-center gap-1.5 rounded-[10px] bg-[#F6F6F1] px-[18px] py-2.5 text-[14px] font-medium text-[#1A1A1A] transition-colors hover:bg-[#EFEFE8] disabled:pointer-events-none disabled:opacity-50",
        className
      )}
    >
      {children}
    </button>
  );
}
