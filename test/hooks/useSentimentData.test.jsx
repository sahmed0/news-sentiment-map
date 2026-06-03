// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { renderHook, act, waitFor, cleanup } from "@testing-library/react";
import { useSentimentData } from "../../src/hooks/useSentimentData.js";

// Response double matching what the hook touches: status, ok, headers.get, json().
const res = (status, body, headers = {}) => ({
  status,
  ok: status >= 200 && status < 300,
  headers: { get: (k) => headers[k] ?? null },
  json: async () => body,
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useSentimentData", () => {
  it("loads data, exposes fromCache, and upcases byCode keys", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      res(200, {
        data: [{ code: "us", name: "US", score: 0.2 }],
        cached: true,
      })
    );

    const { result } = renderHook(() => useSentimentData());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.data).toHaveLength(1);
    expect(result.current.fromCache).toBe(true);
    expect(result.current.byCode.US).toMatchObject({ code: "us" }); // lowercase API code → uppercase key
    expect(result.current.error).toBeNull();
  });

  it("surfaces a non-ok response as an error", async () => {
    global.fetch = vi.fn().mockResolvedValue(res(500, {}));
    const { result } = renderHook(() => useSentimentData());
    await waitFor(() => expect(result.current.error).toBe("API error: 500"));
    expect(result.current.loading).toBe(false);
  });

  it("retries after the Retry-After delay on a 503, then succeeds", async () => {
    vi.useFakeTimers();
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(res(503, { error: "warming" }, { "Retry-After": "1" }))
      .mockResolvedValueOnce(res(200, { data: [{ code: "us", name: "US", score: 0.1 }], cached: true }));

    let result;
    await act(async () => {
      ({ result } = renderHook(() => useSentimentData()));
    });
    // Flush the first (503) response and fire the 1s retry timer + its fetch.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(result.current.data).toHaveLength(1);
    expect(result.current.error).toBeNull();
  });

  it("gives up after 3 retries on persistent 503", async () => {
    vi.useFakeTimers();
    global.fetch = vi.fn().mockResolvedValue(res(503, { error: "warming" }, { "Retry-After": "1" }));

    let result;
    await act(async () => {
      ({ result } = renderHook(() => useSentimentData()));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000); // 3 retries @ 1s each
    });

    expect(global.fetch).toHaveBeenCalledTimes(4); // initial + 3 retries
    expect(result.current.error).toBe("API error: 503");
  });
});
