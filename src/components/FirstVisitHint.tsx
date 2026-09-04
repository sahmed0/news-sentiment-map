// src/components/FirstVisitHint.tsx
import { motion, AnimatePresence } from "framer-motion";
import { X } from "lucide-react";

interface FirstVisitHintProps {
  show: boolean;
  onDismiss: () => void;
}

// A one-time nudge shown once the map has data, so a first-time visitor knows
// it's interactive before they've had to guess. Dismissed on close, on
// selecting any country, or automatically after a few seconds - and never
// shown again once dismissed (see the localStorage flag in App.tsx).
export function FirstVisitHint({ show, onDismiss }: FirstVisitHintProps) {
  return (
    <AnimatePresence>
      {show && (
        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ type: "spring", stiffness: 300, damping: 26 }}
          className="pointer-events-auto flex items-center gap-2 px-4 py-2 rounded-full text-xs sm:text-sm font-medium"
          style={{
            background: "rgb(var(--panel-rgb) / 0.9)",
            backdropFilter: "blur(12px)",
            border: "1px solid rgb(var(--fg-rgb) / 0.12)",
            color: "rgb(var(--fg-rgb) / 0.9)",
          }}
        >
          <span className="relative flex h-2 w-2 shrink-0">
            <span
              className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-60"
              style={{ background: "rgb(var(--fg-rgb))" }}
            />
            <span
              className="relative inline-flex rounded-full h-2 w-2"
              style={{ background: "rgb(var(--fg-rgb))" }}
            />
          </span>
          <span className="hidden sm:inline">Click any country to see its headlines</span>
          <span className="sm:hidden">Tap any country to see its headlines</span>
          <button
            onClick={onDismiss}
            aria-label="Dismiss hint"
            className="ml-1 -mr-1 w-5 h-5 rounded-full flex items-center justify-center opacity-60 hover:opacity-100 transition-opacity"
          >
            <X size={13} />
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
