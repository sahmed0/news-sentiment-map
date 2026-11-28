// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { MockInstance } from "vitest";
import { renderHook, waitFor, cleanup, act } from "@testing-library/react";
import { useCountryHeadlines } from "../../src/hooks/useCountryHeadlines.js";
import type { Article } from "../../shared/types";

const ARTICLES: Article[] = [
  { title: "Hola", translatedTitle: "Hello", url: "https://e.x/1", publishedAt: null, language: "spanish", score: 0.3 },
];

const okBody = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const days = (code: string) => okBody({ code, days: [{ date: "2026-11-20", articles: ARTICLES }] });
const fail = () => ({ ok: false, status: 503, json: async () => ({}) });

// A fetch whose responses the test releases one at a time.
function deferredFetch() {
  const pending: { url: string; signal: AbortSignal; resolve: (v: unknown) => void }[] = [];
  const fn = vi.fn((url: string, init: { signal: AbortSignal }) =>
    new Promise((resolve) => pending.push({ url, signal: init.signal, resolve }))
  );
  return { fn, pending };
}

let consoleError: MockInstance<typeof console.error>;
// The module-level cache can't be reset from outside, so every test uses a
// country code no other test touches.
beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  consoleError = vi.spyOn(console, "error");
});
// Fail any test that triggers a React act() warning.
afterEach(() => {
  cleanup();
  const actWarnings = consoleError.mock.calls.filter((c) => String(c[0]).includes("act("));
  expect(actWarnings).toEqual([]);
});

describe("useCountryHeadlines", () => {
  it("stays idle without fetching when disabled or with no code", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(renderHook(() => useCountryHeadlines("fr", false)).result.current.status).toBe("idle");
    expect(renderHook(() => useCountryHeadlines(null, true)).result.current.status).toBe("idle");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("loads the lowercased code and exposes days by date", async () => {
    const fetchMock = vi.fn().mockResolvedValue(days("es"));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useCountryHeadlines("ES", true));
    expect(result.current.status).toBe("loading");
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.byDate.get("2026-11-20")).toEqual(ARTICLES);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/headlines?code=es");
  });

  it("answers a remount from the cache and stays ready after the entry expires", async () => {
    // Fake only Date: waitFor needs real timers to avoid act() warnings.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const fetchMock = vi.fn().mockResolvedValue(days("ch"));
      vi.stubGlobal("fetch", fetchMock);
      const first = renderHook(() => useCountryHeadlines("ch", true));
      await waitFor(() => expect(first.result.current.status).toBe("ready"));
      first.unmount();

      // A reopened panel: the cache answers, so nothing is fetched.
      const { result, rerender } = renderHook(() => useCountryHeadlines("ch", true));
      expect(result.current.status).toBe("ready");

      vi.setSystemTime(Date.now() + 5 * 60_000 + 1);
      rerender(); // e.g. the next autoplay step
      expect(result.current.status).toBe("ready");
      expect(result.current.byDate.get("2026-11-20")).toEqual(ARTICLES);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces a malformed response and recovers through retry", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okBody({ code: "it", days: "nope" }))
      .mockResolvedValueOnce(days("it"));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useCountryHeadlines("it", true));
    await waitFor(() => expect(result.current.status).toBe("error"));
    const { retry } = result.current;
    act(() => result.current.retry());
    expect(result.current.status).toBe("loading");
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.retry).toBe(retry); // stable across renders
  });

  it("drops malformed days and non-record articles", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        okBody({
          code: "be",
          days: [
            null,
            { date: 5, articles: [] },
            { date: "2026-11-19", articles: "x" },
            { date: "2026-11-20", articles: [null, 3, ...ARTICLES] },
          ],
        })
      )
    );
    const { result } = renderHook(() => useCountryHeadlines("be", true));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect([...result.current.byDate]).toEqual([["2026-11-20", ARTICLES]]);
  });

  it("aborts on a country switch and ignores the old country's late response", async () => {
    const { fn, pending } = deferredFetch();
    vi.stubGlobal("fetch", fn);
    const { result, rerender } = renderHook(({ code }) => useCountryHeadlines(code, true), {
      initialProps: { code: "pt" },
    });
    rerender({ code: "at" });
    expect(pending).toHaveLength(2);
    expect(pending[0].signal.aborted).toBe(true);
    expect(pending[1].signal.aborted).toBe(false);

    await act(async () => pending[0].resolve(days("pt")));
    expect(result.current.status).toBe("loading");
    await act(async () => pending[1].resolve(okBody({ code: "at", days: [{ date: "2026-11-21", articles: ARTICLES }] })));
    expect(result.current.status).toBe("ready");
    expect([...result.current.byDate.keys()]).toEqual(["2026-11-21"]);
  });

  it("shows loading, not the old error, when a failed view returns via Live or another country", async () => {
    const { fn, pending } = deferredFetch();
    vi.stubGlobal("fetch", fn);
    const { result, rerender } = renderHook(({ code, enabled }) => useCountryHeadlines(code, enabled), {
      initialProps: { code: "se", enabled: true },
    });
    await act(async () => pending[0].resolve(fail()));
    expect(result.current.status).toBe("error");

    // Live and back.
    rerender({ code: "se", enabled: false });
    expect(result.current.status).toBe("idle");
    rerender({ code: "se", enabled: true });
    expect(result.current.status).toBe("loading");
    await act(async () => pending[1].resolve(fail()));
    expect(result.current.status).toBe("error");

    // Another country and back.
    rerender({ code: "dk", enabled: true });
    rerender({ code: "se", enabled: true });
    expect(result.current.status).toBe("loading");
    await act(async () => pending[3].resolve(days("se")));
    expect(result.current.status).toBe("ready");
  });
});
