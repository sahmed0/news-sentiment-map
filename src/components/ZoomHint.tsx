// src/components/ZoomHint.tsx

// How to zoom and reset the map. App places it: under MobileToolbar on small
// screens, under Legend on large ones.
export function ZoomHint({ className = "" }: { className?: string }) {
  return (
    <p className={`text-[10px] opacity-60 pointer-events-none ${className}`}>
      {/* Keyed to the input device, not the width: a narrow desktop window
          still scrolls, and a large touch tablet still pinches. */}
      <span className="hidden pointer-coarse:inline">Pinch to zoom · Double-tap the sea to reset</span>
      <span className="pointer-coarse:hidden">Scroll to zoom · Double-click the sea to reset</span>
    </p>
  );
}
