// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, cleanup } from "@testing-library/react";
import { useWorldHistory } from "../../src/hooks/useWorldHistory.js";
import type { WorldHistory } from "../../shared/types";

const HISTORY: WorldHistory = {
  days: ["2026-08-01", "2026-08-02", "2026-08-03"],
  scores: { fr: [0.1, null, 0.2], us: [-0.3, -0.2, -0.1] },
};

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(cleanup);

describe("useWorldHistory", () => {
  it("fetches once, exposes the history and its resolved (uppercased) form", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => HISTORY });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useWorldHistory());
    expect(result.current.loading).toBe(true);

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchMock).toHaveBeenCalledWith("/api/world-history", expect.anything());
    expect(result.current.history).toEqual(HISTORY);
    expect(result.current.error).toBe(false);
    // Carry-forward + uppercase key boundary applied.
    expect(result.current.resolved.FR.map((p) => p.score)).toEqual([0.1, 0.1, 0.2]);
    expect(result.current.resolved.FR[1].carried).toBe(true);
  });

  it("warns and yields an empty history on a non-OK response, never throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) }));

    const { result } = renderHook(() => useWorldHistory());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.history).toEqual({ days: [], scores: {} });
    expect(result.current.resolved).toEqual({});
    expect(result.current.error).toBe(true);
    expect(warn).toHaveBeenCalled();
  });

  it("treats a malformed payload as absent", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ days: "nope" }) }));

    const { result } = renderHook(() => useWorldHistory());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.history).toEqual({ days: [], scores: {} });
    expect(result.current.error).toBe(true);
    expect(warn).toHaveBeenCalled();
  });
});
