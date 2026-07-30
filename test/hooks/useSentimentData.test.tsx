// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { renderHook, act, waitFor, cleanup, type RenderHookResult } from "@testing-library/react";
import { useSentimentData, type UseSentimentData } from "../../src/hooks/useSentimentData";

// Response double matching what the hook touches: status, ok, headers.get, json().
const res = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
  status,
  ok: status >= 200 && status < 300,
  headers: { get: (k: string) => headers[k] ?? null },
  json: async () => body,
});

const okBody = { data: [{ code: "us", name: "US", score: 0.1 }], cached: true };
const warmingHeaders = (seconds?: string): Record<string, string> =>
  seconds ? { "Retry-After": seconds } : {};

// renderHook inside act(): the hook fetches on mount, so the first state
// updates land during render without this.
async function mount(): Promise<RenderHookResult<UseSentimentData, unknown>> {
  let rendered!: RenderHookResult<UseSentimentData, unknown>;
  await act(async () => {
    rendered = renderHook(() => useSentimentData());
  });
  return rendered;
}

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
    expect(result.current.warming).toBeNull();
  });

  it("keeps byCode referentially stable across re-renders", async () => {
    global.fetch = vi.fn().mockResolvedValue(res(200, okBody));

    const { result, rerender } = renderHook(() => useSentimentData());
    await waitFor(() => expect(result.current.loading).toBe(false));

    const first = result.current.byCode;
    rerender();
    expect(result.current.byCode).toBe(first);
  });

  it("surfaces a non-ok response as an error", async () => {
    global.fetch = vi.fn().mockResolvedValue(res(500, {}));
    const { result } = renderHook(() => useSentimentData());
    await waitFor(() => expect(result.current.error).toBe("API error: 500"));
    expect(result.current.loading).toBe(false);
  });

  it("stays in the loading state through a 503 retry, then succeeds", async () => {
    vi.useFakeTimers();
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(res(503, { error: "warming" }, warmingHeaders("2")))
      .mockResolvedValueOnce(res(200, okBody));

    const { result } = await mount();

    // Mid-wait: the overlay must still be up and the banner populated.
    expect(result.current.loading).toBe(true);
    expect(result.current.warming).toEqual({ attempt: 1, maxAttempts: 3, delaySeconds: 2 });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000); // half the delay - retry not due yet
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(result.current.loading).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000); // delay elapsed → retry fires
    });

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(result.current.data).toHaveLength(1);
    expect(result.current.loading).toBe(false);
    expect(result.current.warming).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it("gives up after 3 retries on persistent 503", async () => {
    vi.useFakeTimers();
    global.fetch = vi.fn().mockResolvedValue(res(503, { error: "warming" }, warmingHeaders("1")));

    const { result } = await mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000); // 3 retries @ 1s each
    });

    expect(global.fetch).toHaveBeenCalledTimes(4); // initial + 3 retries
    expect(result.current.error).toBe("The data service is still warming up — try again shortly.");
    expect(result.current.loading).toBe(false);
    expect(result.current.warming).toBeNull();
  });

  it("cancels the pending retry when unmounted mid-wait", async () => {
    vi.useFakeTimers();
    global.fetch = vi.fn().mockResolvedValue(res(503, { error: "warming" }, warmingHeaders("5")));

    const { unmount } = await mount();
    expect(global.fetch).toHaveBeenCalledTimes(1);

    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(global.fetch).toHaveBeenCalledTimes(1); // timer cleared, nothing fired
  });

  it("refetches in the background when a stale tab becomes visible", async () => {
    vi.useFakeTimers();
    global.fetch = vi.fn().mockResolvedValue(res(200, okBody));

    const { result } = await mount();
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(result.current.loading).toBe(false);

    // Under the 5-minute threshold: the cached body would be identical.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4 * 60_000);
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2 * 60_000); // now 6 minutes stale
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(result.current.loading).toBe(false); // background: never re-blanks the map
    expect(result.current.data).toHaveLength(1);
  });

  it("does not refetch when the tab becomes hidden", async () => {
    vi.useFakeTimers();
    global.fetch = vi.fn().mockResolvedValue(res(200, okBody));

    await mount();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    visibility.mockRestore();
  });

  it("clamps an absurd Retry-After to 30s", async () => {
    vi.useFakeTimers();
    global.fetch = vi.fn().mockResolvedValue(res(503, {}, warmingHeaders("999")));

    const { result } = await mount();
    expect(result.current.warming?.delaySeconds).toBe(30);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(29_000);
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("falls back to 5s when Retry-After is missing", async () => {
    vi.useFakeTimers();
    global.fetch = vi.fn().mockResolvedValue(res(503, {}, warmingHeaders()));

    const { result } = await mount();
    expect(result.current.warming?.delaySeconds).toBe(5);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_999);
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("recovers via the manual refetch after retries are exhausted", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(res(503, {}, warmingHeaders("1")))
      .mockResolvedValueOnce(res(503, {}, warmingHeaders("1")));
    global.fetch = fetchMock;

    const { result } = await mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(result.current.error).not.toBeNull();

    fetchMock.mockResolvedValue(res(200, okBody));
    await act(async () => {
      result.current.refetch();
    });

    expect(result.current.error).toBeNull();
    expect(result.current.data).toHaveLength(1);
    expect(result.current.loading).toBe(false);
  });
});
