// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { WorldSummary } from "../../src/components/WorldSummary.js";
import type { WorldSummary as WorldSummaryResult } from "../../src/lib/summary";

afterEach(cleanup);

const SUMMARY: WorldSummaryResult = {
  score: -0.14,
  baseline: -0.02,
  delta: -0.12,
  countries: 42,
  headline: "More negative than usual",
  detail: "−0.14 today · 0.12 below the 30-day average",
};

describe("WorldSummary", () => {
  it("renders the headline above the detail line", () => {
    render(<WorldSummary summary={SUMMARY} />);

    expect(screen.getByText("More negative than usual")).toBeTruthy();
    expect(screen.getByText("−0.14 today · 0.12 below the 30-day average")).toBeTruthy();
  });

  it("renders nothing when there is no summary to show", () => {
    const { container } = render(<WorldSummary summary={null} />);
    expect(container.firstChild).toBeNull();
  });
});
