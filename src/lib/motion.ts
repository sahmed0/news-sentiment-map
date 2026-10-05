// Reduced-motion transition config, factored out of the components that use
// it so the OS-level prefers-reduced-motion branch is unit-testable: jsdom
// can't usefully assert that a framer-motion element didn't move, but it can
// assert which config a component handed to motion.div.
import type { MotionProps } from "framer-motion";

type EdgeMotion = Pick<MotionProps, "initial" | "animate" | "exit">;

// Sheets and side panels normally slide in from an edge (`axis`/`offset` name
// which one - "y"/"100%" for a bottom sheet, "x"/"100%" for the desktop side
// panel). Reduced motion drops the slide and keeps only the fade: the OS-level
// request is to avoid motion, not just to speed it up.
export function edgeMotion(reduced: boolean, axis: "x" | "y", offset: string): EdgeMotion {
  if (reduced) {
    return { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } };
  }
  return {
    initial: { [axis]: offset, opacity: 0 },
    animate: { [axis]: 0, opacity: 1 },
    exit: { [axis]: offset, opacity: 0 },
  };
}

type GrowMotion = Pick<MotionProps, "initial" | "animate" | "transition">;

// Width-fill bars (SentimentBar, Legend's rank rows) animate in from 0%.
// Reduced motion renders at the final width immediately: `initial={false}`
// skips the mount animation, and a zero-duration transition stops a later
// width change (e.g. a rescored country) from animating either.
export function growMotion(
  reduced: boolean,
  widthPct: number,
  transition: MotionProps["transition"],
): GrowMotion {
  const animate = { width: `${widthPct}%` };
  if (reduced) {
    return { initial: false, animate, transition: { duration: 0 } };
  }
  return { initial: { width: 0 }, animate, transition };
}
