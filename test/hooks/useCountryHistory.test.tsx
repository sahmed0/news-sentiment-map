// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, cleanup } from "@testing-library/react";
import { useCountryHistory } from "../../src/hooks/useCountryHistory.js";
import type { HistoryPoint } from "../../shared/types";

const POINTS: HistoryPoint[] = [
  { date: "2026-07-20", score: 0.1, n: 4 },
  { date: "2026-07-21", score: 0.2, n: 5 },
];

const okBody = (points: HistoryPoint[], code = "us") => ({
  ok: true,
  status: 200,
  json: async () => ({ code, points }),
});

// The module-level cache is deliberately not resettable from outside, so every
// test uses a country code no other test touches.
beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(cleanup);

describe("useCountryHistory", () => {
  it("fetches the lowercased code and exposes the points", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okBody(POINTS));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useCountryHistory("FR"));
    expect(result.current.loading).toBe(true);

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.points).toEqual(POINTS);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/history?code=fr");
  });

  it("does not fetch again for the same country within the cache TTL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okBody(POINTS));
    vi.stubGlobal("fetch", fetchMock);

    const first = renderHook(() => useCountryHistory("de"));
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    first.unmount();

    // Re-opening the panel must paint from the cache on the first render, with
    // no loading frame at all.
    const second = renderHook(() => useCountryHistory("de"));
    expect(second.result.current.loading).toBe(false);
    expect(second.result.current.points).toEqual(POINTS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refetches once the cached series is older than the TTL", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn().mockResolvedValue(okBody(POINTS));
      vi.stubGlobal("fetch", fetchMock);

      const first = renderHook(() => useCountryHistory("it"));
      await vi.waitFor(() => expect(first.result.current.loading).toBe(false));
      first.unmount();

      vi.advanceTimersByTime(5 * 60_000 + 1);

      const second = renderHook(() => useCountryHistory("it"));
      await vi.waitFor(() => expect(second.result.current.loading).toBe(false));
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts the in-flight request when the country changes", async () => {
    const signals: AbortSignal[] = [];
    const fetchMock = vi.fn((_url: string, init: { signal: AbortSignal }) => {
      signals.push(init.signal);
      return new Promise(() => {}); // never settles - the abort is the outcome
    });
    vi.stubGlobal("fetch", fetchMock);

    const { rerender } = renderHook(({ code }) => useCountryHistory(code), {
      initialProps: { code: "es" },
    });
    rerender({ code: "pt" });

    expect(signals).toHaveLength(2);
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
  });

  it("hides the section instead of surfacing an error when the request fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    const { result } = renderHook(() => useCountryHistory("nl"));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.points).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });

  it("treats a non-OK response the same way", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({}) }));

    const { result } = renderHook(() => useCountryHistory("be"));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.points).toEqual([]);
    expect(warn.mock.calls[0].join(" ")).toContain("400");
  });

  it("stays idle with no selected country", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useCountryHistory(null));

    expect(result.current).toEqual({ points: [], loading: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
