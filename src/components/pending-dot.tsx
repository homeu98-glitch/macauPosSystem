"use client";

type PendingDotProps = {
  className?: string;
};

export function PendingDot({ className = "" }: PendingDotProps) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full bg-red-500 ${className}`}
    />
  );
}
