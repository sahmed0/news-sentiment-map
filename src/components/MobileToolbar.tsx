// src/components/MobileToolbar.tsx
import type { ReactNode } from "react";
import { useIsMobile } from "../hooks/useMediaQuery";

export interface MobileToolbarItem {
  key: string;
  label: string;
  icon: ReactNode;
  active?: boolean;
  badge?: boolean;
  onPress: () => void;
}

interface MobileToolbarProps {
  items: MobileToolbarItem[];
}

// Maps-style bottom toolbar. Each item opens a sheet; the toolbar itself
// never grows a "coming soon" placeholder - it only ever ships items that work.
export function MobileToolbar({ items }: MobileToolbarProps) {
  const isMobile = useIsMobile();
  if (!isMobile) return null;

  return (
    <div
      className="absolute inset-x-0 bottom-0 z-20 flex items-stretch justify-evenly pb-[env(safe-area-inset-bottom)]"
      style={{
        background: "rgb(var(--panel-rgb) / 0.85)",
        backdropFilter: "blur(12px)",
        borderTop: "1px solid rgb(var(--fg-rgb) / 0.08)",
      }}
    >
      {items.map((item) => (
        <button
          key={item.key}
          onClick={item.onPress}
          className="relative flex-1 min-w-[44px] min-h-[44px] flex flex-col items-center justify-center gap-0.5 py-1.5"
          style={{ color: item.active ? "rgb(var(--fg-rgb))" : "rgb(var(--fg-rgb) / 0.6)" }}
          aria-pressed={item.active}
        >
          {item.icon}
          <span className="text-[10px] font-medium">{item.label}</span>
          {item.badge && (
            <span
              className="absolute top-1.5 right-1/2 translate-x-3 w-1.5 h-1.5 rounded-full"
              style={{ background: "rgb(var(--c-negative-rgb))" }}
              aria-hidden="true"
            />
          )}
        </button>
      ))}
    </div>
  );
}
