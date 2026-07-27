// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { Article, CountryResult, HistoryPoint } from "../../shared/types";

// The panel's only new dependency is the history hook; mocking it is what lets
// this file stand in for a browser check against real /api/history data.
vi.mock("../../src/hooks/useCountryHistory.js", () => ({
  useCountryHistory: vi.fn(() => ({ points: [], loading: false })),
}));

import { useCountryHistory } from "../../src/hooks/useCountryHistory.js";
import { CountryPanel } from "../../src/components/CountryPanel.js";

const COUNTRY: CountryResult = {
  code: "us",
  name: "United States",
  score: 0.25,
  status: "ok",
  articles: [],
  fetchedAt: "2026-07-22T00:00:00.000Z",
};

// A rising series a week apart, so computeDelta7d has a point to compare with.
const series = (scores: number[]): HistoryPoint[] =>
  scores.map((score, i) => ({ date: `2026-07-${String(i + 1).padStart(2, "0")}`, score, n: 4 }));

const mockHistory = (points: HistoryPoint[], loading = false) =>
  vi.mocked(useCountryHistory).mockReturnValue({ points, loading });

// matchMedia (which the panel asks for to pick its layout) is stubbed globally
// in test/setup.ts.
beforeEach(() => {
  vi.mocked(useCountryHistory).mockReset();
});
afterEach(cleanup);

describe("CountryPanel history section", () => {
  it("shows the sparkline and the 7-day delta once enough days exist", () => {
    // 8 daily points: the latest (0.40) against the point seven days back
    // (0.10) gives +0.30.
    mockHistory(series([0.1, 0.15, 0.2, 0.2, 0.25, 0.3, 0.35, 0.4]));
    const { container } = render(<CountryPanel country={COUNTRY} onClose={() => {}} />);

    expect(screen.getByText("30-day trend")).toBeTruthy();
    expect(container.querySelector("svg polyline")).toBeTruthy();
    expect(screen.getByText(/7d/).textContent?.replace(/\s+/g, " ")).toBe("7d ▲ +0.30");
    expect(screen.queryByText(/History accumulates daily/)).toBeNull();
  });

  it("marks a fall with a down arrow and a minus sign", () => {
    mockHistory(series([0.5, 0.4, 0.3, 0.3, 0.2, 0.2, 0.1, 0.05]));
    render(<CountryPanel country={COUNTRY} onClose={() => {}} />);

    expect(screen.getByText(/7d/).textContent?.replace(/\s+/g, " ")).toBe("7d ▼ −0.45");
  });

  it("shows the accumulation note, and no chart, below three points", () => {
    mockHistory(series([0.1, 0.2]));
    const { container } = render(<CountryPanel country={COUNTRY} onClose={() => {}} />);

    expect(screen.getByText("History accumulates daily — check back soon.")).toBeTruthy();
    expect(container.querySelector("svg polyline")).toBeNull();
    // No chip either - two points can't describe a week.
    expect(screen.queryByText(/7d/)).toBeNull();
  });

  it("treats an empty series like a cold start rather than an error", () => {
    mockHistory([]);
    render(<CountryPanel country={COUNTRY} onClose={() => {}} />);

    expect(screen.getByText("History accumulates daily — check back soon.")).toBeTruthy();
  });

  it("renders no history markup at all while loading, so the panel can't jump", () => {
    mockHistory([], true);
    const { container } = render(<CountryPanel country={COUNTRY} onClose={() => {}} />);

    expect(screen.queryByText("30-day trend")).toBeNull();
    expect(screen.queryByText(/History accumulates daily/)).toBeNull();
    expect(container.querySelector("svg polyline")).toBeNull();
    // The rest of the panel is unaffected - the section appears in place below.
    expect(screen.getByText("United States")).toBeTruthy();
    expect(screen.getByText("Headlines")).toBeTruthy();
  });

  it("asks for the selected country's code", () => {
    mockHistory([]);
    render(<CountryPanel country={COUNTRY} onClose={() => {}} />);

    expect(vi.mocked(useCountryHistory).mock.calls[0][0]).toBe("us");
  });
});

