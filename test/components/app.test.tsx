// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { CountryResult } from "../../shared/types";
import type { UseSentimentData } from "../../src/hooks/useSentimentData";

vi.mock("../../src/hooks/useSentimentData.js", () => ({
  useSentimentData: vi.fn(),
}));

// The scrubber's data source. Default: empty history (no scrubber) - individual
// tests override it to exercise the timeline.
vi.mock("../../src/hooks/useWorldHistory.js", () => ({
  useWorldHistory: vi.fn(() => ({
    history: { days: [], scores: {} },
    resolved: {},
    loading: false,
    error: true,
  })),
}));

// The map is not what these assertions are about, and mounting it would parse
// the bundled 110m topology and project ~180 features per test.
vi.mock("../../src/components/WorldMap.js", () => ({
  WorldMap: () => <svg data-testid="worldmap" />,
}));

import { useSentimentData } from "../../src/hooks/useSentimentData.js";
import { useWorldHistory } from "../../src/hooks/useWorldHistory.js";
import { resolveWorldHistory } from "../../src/lib/worldHistory.js";
import type { WorldHistory } from "../../shared/types";
import App from "../../src/App.js";

const COUNTRY: CountryResult = {
  code: "us",
  name: "United States",
  score: 0.25,
  status: "ok",
  articles: [],
  fetchedAt: "2026-07-22T09:00:00.000Z",
};

const refetch = vi.fn();

const mockHook = (over: Partial<UseSentimentData> = {}) =>
  vi.mocked(useSentimentData).mockReturnValue({
    data: [],
    byCode: {},
    loading: false,
    warming: null,
    error: null,
    lastUpdated: null,
    fromCache: false,
    refetch,
    ...over,
  });

const EMPTY_WORLD_HISTORY = { history: { days: [], scores: {} }, resolved: {}, loading: false, error: true };

const mockWorldHistory = (days: string[]) => {
  const history: WorldHistory = {
    days,
    scores: { us: days.map((_, i) => Math.min(0.9, -0.3 + i * 0.02)) },
  };
  vi.mocked(useWorldHistory).mockReturnValue({
    history,
    resolved: resolveWorldHistory(history),
    loading: false,
    error: false,
  });
};

const days = (n: number) =>
  Array.from({ length: n }, (_, i) => `2026-08-${String(i + 1).padStart(2, "0")}`);

beforeEach(() => {
  vi.mocked(useSentimentData).mockReset();
  vi.mocked(useWorldHistory).mockReset();
  vi.mocked(useWorldHistory).mockReturnValue(EMPTY_WORLD_HISTORY);
  refetch.mockReset();
});
afterEach(cleanup);

describe("App warm-up banner", () => {
  it("explains the cold start with the attempt and the delay", () => {
    mockHook({ loading: true, warming: { attempt: 2, maxAttempts: 3, delaySeconds: 5 } });
    render(<App />);

    expect(screen.getByText(/Waking the data service/).textContent).toBe(
      "Waking the data service… retrying in ~5s (attempt 2/3)"
    );
    // The overlay stays up through the retries
    expect(screen.getByText(/Fetching headlines/)).toBeTruthy();
  });

  it("shows no banner when nothing is warming", () => {
    mockHook({ loading: true });
    render(<App />);

    expect(screen.queryByText(/Waking the data service/)).toBeNull();
  });
});

describe("App error banner", () => {
  it("shows the message and refetches when Retry is pressed", () => {
    mockHook({ error: "API error: 500" });
    render(<App />);

    expect(screen.getByText("Error: API error: 500")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("shows no error banner on the happy path", () => {
    mockHook({ data: [COUNTRY] });
    render(<App />);

    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });
});

describe("App brand block", () => {
  it("renders the title on desktop", () => {
    mockHook({ data: [COUNTRY] });
    render(<App />);

    expect(screen.getByText("World News Sentiment")).toBeTruthy();
  });

  it("renders the title on mobile too (regression: it used to be hidden below sm)", () => {
    const realMatchMedia = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;

    try {
      mockHook({ data: [COUNTRY] });
      render(<App />);

      expect(screen.getByText("World News Sentiment")).toBeTruthy();
    } finally {
      window.matchMedia = realMatchMedia;
    }
  });
});

describe("App mobile toolbar", () => {
  it("shows Filter and Legend items that open sheets, with no old bottom filter bar", () => {
    const realMatchMedia = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;

    try {
      mockHook({ data: [COUNTRY] });
      render(<App />);

      fireEvent.click(screen.getByRole("button", { name: "Filter" }));
      expect(screen.getByRole("heading", { name: "Filter by sentiment" })).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: "Legend" }));
      expect(screen.getByRole("heading", { name: "Legend & rankings" })).toBeTruthy();
    } finally {
      window.matchMedia = realMatchMedia;
    }
  });

  // Regression: the toolbar and the info panel share the bottom edge on
  // mobile at the same z-index. Left both up at once, the toolbar (which has
  // no closed state of its own) would paint over the panel's last ~60px and
  // stay tappable there, and a sheet opened earlier would linger underneath it.
  it("hides itself and closes any open sheet once the info panel opens", () => {
    const realMatchMedia = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;

    try {
      mockHook({ data: [COUNTRY] });
      render(<App />);

      fireEvent.click(screen.getByRole("button", { name: "Filter" }));
      expect(screen.getByRole("heading", { name: "Filter by sentiment" })).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: "About this project" }));

      expect(screen.queryByRole("heading", { name: "Filter by sentiment" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Filter" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Legend" })).toBeNull();
    } finally {
      window.matchMedia = realMatchMedia;
    }
  });
});

describe("App time scrubber", () => {
  it("shows no scrubber with fewer than a week of history", () => {
    mockHook({ data: [COUNTRY] });
    mockWorldHistory(days(6));
    render(<App />);

    expect(screen.queryByRole("slider")).toBeNull();
  });

  it("renders the desktop scrubber once there is enough history", () => {
    mockHook({ data: [COUNTRY] });
    mockWorldHistory(days(20));
    render(<App />);

    expect(screen.getByRole("slider")).toBeTruthy();
    // Starts live: the LIVE button is disabled on the latest day.
    expect((screen.getByRole("button", { name: "Live" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("adds a Time item to the mobile toolbar that opens the timeline sheet", () => {
    const realMatchMedia = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;

    try {
      mockHook({ data: [COUNTRY] });
      mockWorldHistory(days(20));
      render(<App />);

      fireEvent.click(screen.getByRole("button", { name: "Time" }));
      expect(screen.getByRole("heading", { name: "Timeline" })).toBeTruthy();
      // The desktop dock plus the sheet's own copy.
      expect(screen.getAllByRole("slider").length).toBeGreaterThanOrEqual(1);
    } finally {
      window.matchMedia = realMatchMedia;
    }
  });
});

describe("App map furniture", () => {
  it("shows the filter and the legend only once data has arrived", () => {
    mockHook({ loading: true });
    const { rerender } = render(<App />);

    expect(screen.queryByText("Filter by sentiment")).toBeNull();
    expect(screen.queryByText("Legend & rankings")).toBeNull();

    mockHook({ data: [COUNTRY], lastUpdated: new Date("2026-07-22T09:05:00.000Z") });
    rerender(<App />);

    expect(screen.getByText("Filter by sentiment")).toBeTruthy();
    expect(screen.getByText("Legend & rankings")).toBeTruthy();
    // One scored country, counted under both "all" and its bucket.
    expect(screen.getByRole("button", { name: /^All/ }).textContent).toBe("All 1");
    expect(screen.getByRole("button", { name: /^Positive/ }).textContent).toBe("Positive 1");
  });
});
