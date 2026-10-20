// src/components/BrandBlock.tsx
import type { ReactNode } from "react";

interface BrandBlockProps {
  children?: ReactNode;
}

// The top-left card holding the world summary. The app title stays as the
// page's <h1> for screen readers and search engines, but isn't drawn.
// With no children (no summary yet) the card is skipped.
export function BrandBlock({ children }: BrandBlockProps) {
  return (
    <>
      <h1 className="sr-only">World News Sentiment</h1>
      {children && (
        <div
          className="pointer-events-none rounded-lg py-1.5 px-3 text-left"
          style={{
            background: "rgb(var(--panel-rgb) / 0.85)",
            backdropFilter: "blur(12px)",
            border: "1px solid rgb(var(--fg-rgb) / 0.08)",
            color: "rgb(var(--fg-rgb))",
          }}
        >
          {children}
        </div>
      )}
    </>
  );
}
