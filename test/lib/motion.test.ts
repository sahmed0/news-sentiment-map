import { describe, it, expect } from "vitest";
import { edgeMotion, growMotion } from "../../src/lib/motion.js";

describe("edgeMotion", () => {
  it("slides in from the given axis/offset when motion is not reduced", () => {
    expect(edgeMotion(false, "y", "100%")).toEqual({
      initial: { y: "100%", opacity: 0 },
      animate: { y: 0, opacity: 1 },
      exit: { y: "100%", opacity: 0 },
    });
    expect(edgeMotion(false, "x", "100%")).toEqual({
      initial: { x: "100%", opacity: 0 },
      animate: { x: 0, opacity: 1 },
      exit: { x: "100%", opacity: 0 },
    });
  });

  it("drops the slide and keeps only the fade when motion is reduced", () => {
    expect(edgeMotion(true, "y", "100%")).toEqual({
      initial: { opacity: 0 },
      animate: { opacity: 1 },
      exit: { opacity: 0 },
    });
    // The axis/offset are irrelevant once reduced - no position ever appears.
    expect(edgeMotion(true, "x", "50%")).toEqual({
      initial: { opacity: 0 },
      animate: { opacity: 1 },
      exit: { opacity: 0 },
    });
  });
});

describe("growMotion", () => {
  const transition = { duration: 0.5, delay: 0.1, ease: "easeOut" as const };

  it("animates in from 0 width with the caller's transition when motion is not reduced", () => {
    expect(growMotion(false, 42, transition)).toEqual({
      initial: { width: 0 },
      animate: { width: "42%" },
      transition,
    });
  });

  it("renders at the final width immediately with no transition when motion is reduced", () => {
    expect(growMotion(true, 42, transition)).toEqual({
      initial: false,
      animate: { width: "42%" },
      transition: { duration: 0 },
    });
  });
});
