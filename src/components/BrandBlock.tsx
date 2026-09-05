// src/components/BrandBlock.tsx
import type { ReactNode } from "react";

interface BrandBlockProps {
  children?: ReactNode;
}

// App identity: title + tagline, visible at every breakpoint. The
// children slot holds the summary stat once that ships.
export function BrandBlock({ children }: BrandBlockProps) {
  return (
    <div
      className="pointer-events-none rounded-lg py-1 px-3 text-left"
      style={{
        background: "rgb(var(--panel-rgb) / 0.85)",
        backdropFilter: "blur(12px)",
        border: "1px solid rgb(var(--fg-rgb) / 0.08)",
        color: "rgb(var(--fg-rgb))",
      }}
    >
      <h1
        className="text-base sm:text-2xl font-black tracking-tight truncate"
        style={{ fontFamily: "'DM Serif Display', serif", letterSpacing: "-0.02em" }}
      >
        World News Sentiment
      </h1>
      <p className="text-[10px] sm:text-xs uppercase tracking-wide opacity-60 truncate mt-0.5">
        Emotional temperature of global headlines
      </p>
      {children}
    </div>
  );
}
