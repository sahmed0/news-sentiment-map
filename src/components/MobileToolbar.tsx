// src/components/MobileToolbar.tsx
import type { ReactNode } from "react";
import { useIsMobile } from "../hooks/useMediaQuery";

export interface MobileToolbarItem {
  key: string;
  // Not shown - the icon carries the meaning - but it is the button's
  // accessible name and tooltip.
  label: string;
  icon: ReactNode;
  active?: boolean;
  badge?: boolean;
  onPress: () => void;
}

interface MobileToolbarProps {
  items: MobileToolbarItem[];
}

// Floating icon pill along the bottom edge. Each item opens a Tray.
// Positioning is the caller's job (App stacks the open Tray above it).
export function MobileToolbar({ items }: MobileToolbarProps) {
  const isMobile = useIsMobile();
  if (!isMobile) return null;

  return (
    <nav
      aria-label="Map tools"
      className="pointer-events-auto flex items-center gap-1 rounded-full p-1"
      style={{
        background: "rgb(var(--panel-rgb) / 0.85)",
        backdropFilter: "blur(12px)",
        border: "1px solid rgb(var(--fg-rgb) / 0.08)",
      }}
    >
      {items.map((item) => (
        <button
          key={item.key}
          onClick={item.onPress}
          className="relative w-11 h-11 rounded-full flex items-center justify-center transition-colors"
          style={{
            background: item.active ? "rgb(var(--fg-rgb) / 0.14)" : "transparent",
            color: item.active ? "rgb(var(--fg-rgb))" : "rgb(var(--fg-rgb) / 0.65)",
          }}
          aria-label={item.label}
          title={item.label}
          aria-pressed={item.active}
        >
          {item.icon}
          {item.badge && (
            <span
              className="absolute top-2 right-2 w-1.5 h-1.5 rounded-full"
              style={{ background: "rgb(var(--c-negative-rgb))" }}
              aria-hidden="true"
            />
          )}
        </button>
      ))}
    </nav>
  );
}
