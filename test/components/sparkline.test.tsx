// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { Sparkline } from "../../src/components/Sparkline.js";
import type { HistoryPoint } from "../../shared/types";

const pt = (date: string, score: number): HistoryPoint => ({ date, score, n: 3 });

afterEach(cleanup);

describe("Sparkline", () => {
  it("renders the baseline, the polyline and an end marker", () => {
    const { container } = render(
      <Sparkline points={[pt("2026-07-01", -0.5), pt("2026-07-02", 0), pt("2026-07-03", 0.5)]} />
    );

    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("viewBox")).toBe("0 0 100 36");
    expect(svg?.getAttribute("preserveAspectRatio")).toBe("none");
    expect(container.querySelector("polyline")?.getAttribute("points")).toBe("0,26 50,18 100,10");

    // Baseline plus the round-capped end marker; the marker is drawn as a
    // zero-length line so it stays circular under the non-uniform scaling.
    expect(container.querySelectorAll("line")).toHaveLength(2);
    const dot = container.querySelector('line[stroke-linecap="round"]');
    expect(dot?.getAttribute("x1")).toBe("100");
    expect(dot?.getAttribute("x1")).toBe(dot?.getAttribute("x2"));
  });

  it("renders the marker only, and no line geometry, for a single point", () => {
    const { container } = render(<Sparkline points={[pt("2026-07-01", 0.5)]} />);

    expect(container.querySelector("polyline")?.getAttribute("points")).toBe("0,10");
    const dot = container.querySelector('line[stroke-linecap="round"]');
    expect(dot?.getAttribute("x1")).toBe("0");
  });

  it("renders nothing for an empty series", () => {
    const { container } = render(<Sparkline points={[]} />);
    expect(container.querySelector("svg")).toBeNull();
  });
});
