// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { CountryResult } from "../../shared/types";
import type { UseSentimentData } from "../../src/hooks/useSentimentData";

vi.mock("../../src/hooks/useSentimentData.js", () => ({
  useSentimentData: vi.fn(),
}));

// The map is not what these assertions are about, and mounting it would parse
// the bundled 110m topology and project ~180 features per test.
vi.mock("../../src/components/WorldMap.js", () => ({
  WorldMap: () => <svg data-testid="worldmap" />,
}));

import { useSentimentData } from "../../src/hooks/useSentimentData.js";
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

beforeEach(() => {
  vi.mocked(useSentimentData).mockReset();
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
