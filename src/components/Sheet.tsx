// src/components/Sheet.tsx
import type { ReactNode } from "react";
import { motion, AnimatePresence, useDragControls, type PanInfo } from "framer-motion";
import { X } from "lucide-react";

interface SheetProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}

// Reusable mobile bottom sheet. Drag-to-dismiss mechanics are copied
// verbatim from CountryPanel's mobile mode so the two feel identical.
export function Sheet({ open, onClose, title, children }: SheetProps) {
  const dragControls = useDragControls();

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="sheet"
          initial={{ y: "100%", opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: "100%", opacity: 0 }}
          drag="y"
          dragListener={false}
          dragControls={dragControls}
          dragConstraints={{ top: 0, bottom: 0 }}
          dragElastic={{ top: 0, bottom: 0.6 }}
          onDragEnd={(_: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
            if (info.offset.y > 120 || info.velocity.y > 500) onClose();
          }}
          transition={{ type: "spring", stiffness: 300, damping: 30 }}
          className="absolute z-20 flex flex-col inset-x-0 bottom-0 max-h-[70dvh] rounded-t-2xl pb-[env(safe-area-inset-bottom)]"
          style={{
            background: "rgb(var(--panel-rgb) / 0.85)",
            backdropFilter: "blur(16px)",
            border: "1px solid rgb(var(--fg-rgb) / 0.08)",
          }}
        >
          {/* Grab handle - drag target for swipe-to-dismiss */}
          <div
            className="flex justify-center pt-3 pb-2 shrink-0 cursor-grab active:cursor-grabbing touch-none"
            onPointerDown={(e) => dragControls.start(e)}
          >
            <div className="h-1 w-10 rounded-full bg-fg/25" />
          </div>

          {/* Header */}
          <div className="flex items-center justify-between px-5 pb-3 border-b border-fg/8 shrink-0">
            <h2 className="text-sm font-semibold uppercase tracking-widest opacity-70">
              {title}
            </h2>
            <button
              onClick={onClose}
              className="w-9 h-9 shrink-0 -mr-1.5 rounded-full flex items-center justify-center text-gray-400 transition-colors"
              aria-label="Close"
            >
              <X />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
