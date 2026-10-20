// src/components/Tray.tsx
import { useEffect, useRef, useState, type ReactNode } from "react";
import { motion, useDragControls, useReducedMotion, type PanInfo } from "framer-motion";
import { edgeMotion } from "../lib/motion";
import { X } from "lucide-react";

interface TrayProps {
  onClose: () => void;
  // Announced to screen readers only.
  label: string;
  // "start" pins the close button to the top corner of a tall tray (Legend);
  // strips (Filter, Time) centre it.
  align?: "center" | "start";
  children: ReactNode;
}

// Compact mobile popup that floats above MobileToolbar. Render it inside an
// AnimatePresence - App keeps one for all trays so switching between them
// swaps one card for the next.
export function Tray({ onClose, label, align = "center", children }: TrayProps) {
  const dragControls = useDragControls();
  const reducedMotion = useReducedMotion();
  const bodyRef = useRef<HTMLDivElement>(null);
  // A body taller than its max height (Legend on a landscape phone) has to
  // scroll, so it gives up swipe-to-dismiss and lets the browser pan it.
  const [scrollable, setScrollable] = useState(false);

  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const measure = () => setScrollable(body.scrollHeight > body.clientHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(body);
    if (body.firstElementChild) ro.observe(body.firstElementChild);
    return () => ro.disconnect();
  }, []);

  const startSwipe = (e: React.PointerEvent) => {
    const target = e.target as Element;
    // The scrubber drags sideways, and a scrolling body pans; neither dismisses.
    if (target.closest('input[type="range"]')) return;
    if (scrollable && bodyRef.current?.contains(target)) return;
    dragControls.start(e);
  };

  return (
    <motion.div
      role="dialog"
      aria-label={label}
      {...edgeMotion(!!reducedMotion, "y", "16px")}
      drag="y"
      dragListener={false}
      dragControls={dragControls}
      dragConstraints={{ top: 0, bottom: 0 }}
      dragElastic={{ top: 0, bottom: 0.6 }}
      onDragEnd={(_: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
        if (info.offset.y > 60 || info.velocity.y > 400) onClose();
      }}
      transition={{ type: "spring", stiffness: 400, damping: 34 }}
      onPointerDown={startSwipe}
      className={`pointer-events-auto w-full flex gap-1 rounded-2xl p-2 touch-none ${
        align === "start" ? "items-start" : "items-center"
      }`}
      style={{
        background: "rgb(var(--panel-rgb) / 0.85)",
        backdropFilter: "blur(16px)",
        border: "1px solid rgb(var(--fg-rgb) / 0.08)",
      }}
    >
      <div
        ref={bodyRef}
        className={`flex-1 min-w-0 max-h-[60dvh] overflow-y-auto ${scrollable ? "touch-pan-y" : "touch-none"}`}
      >
        <div>{children}</div>
      </div>
      <button
        onClick={onClose}
        className="w-7 h-7 shrink-0 rounded-full flex items-center justify-center text-fg/60"
        aria-label="Close"
      >
        <X size={16} />
      </button>
    </motion.div>
  );
}
