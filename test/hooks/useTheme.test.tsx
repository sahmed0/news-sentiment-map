// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useTheme } from "../../src/hooks/useTheme.js";

const KEY = "nsm-theme-choice";
const OLD_KEY = "nsm-theme";

// index.html's real inline script, read from disk rather than copied,
// so the test catches the two drifting apart.
const PRE_PAINT = (() => {
  const html = readFileSync(resolve(__dirname, "../../index.html"), "utf8");
  const match = /<script>([\s\S]*?)<\/script>/.exec(html);
  if (!match) throw new Error("index.html has no inline <script>");
  return new Function(match[1]) as () => void;
})();

const html = document.documentElement;
const originalMatchMedia = window.matchMedia;

// test/setup.ts answers "no" to every query. The light-OS cases answer "yes",
// to show the OS setting is ignored.
function setOsPrefersLight(light: boolean) {
  window.matchMedia = ((query: string) => ({
    ...originalMatchMedia(query),
    matches: light && query === "(prefers-color-scheme: light)",
  })) as typeof window.matchMedia;
}

function storageSnapshot(): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)!;
    out[k] = localStorage.getItem(k)!;
  }
  return out;
}

// Run the pre-paint script, then mount the hook, and return both so each case
// can compare them.
function firstPaintAndHook() {
  html.classList.remove("theme-light");
  PRE_PAINT();
  const prePaintLight = html.classList.contains("theme-light");
  const view = renderHook(() => useTheme());
  return { prePaintLight, view };
}

beforeEach(() => {
  localStorage.clear();
  html.classList.remove("theme-light");
  window.matchMedia = originalMatchMedia;
});
afterEach(() => {
  cleanup();
  window.matchMedia = originalMatchMedia;
});

describe("useTheme - a toggled choice, else dark, agreeing with index.html", () => {
  it.each([
    ["stored light, OS dark", "light", "light", false],
    ["stored dark, OS light", "dark", "dark", true],
    ["nothing stored, OS no preference", "dark", null, false],
    ["nothing stored, OS light", "dark", null, true],
    ["unrecognised stored value, OS light", "dark", "sepia", true],
  ] as const)("%s → %s", (_label, expected, stored, osLight) => {
    if (stored) localStorage.setItem(KEY, stored);
    setOsPrefersLight(osLight);

    const { prePaintLight, view } = firstPaintAndHook();

    expect(view.result.current.theme).toBe(expected);
    expect(prePaintLight).toBe(expected === "light");
    expect(html.classList.contains("theme-light")).toBe(expected === "light");
  });

  it("ignores a stale \"light\" under the old key: a returning visitor gets dark", () => {
    // Every past visitor has this: the old hook wrote it on mount, unchosen.
    localStorage.setItem(OLD_KEY, "light");

    const { prePaintLight, view } = firstPaintAndHook();

    expect(view.result.current.theme).toBe("dark");
    expect(prePaintLight).toBe(false);
  });
});

describe("useTheme - storage", () => {
  it("stores nothing on a first visit, and the toggled value after toggle()", () => {
    const { result } = renderHook(() => useTheme());

    expect(result.current.theme).toBe("dark");
    expect(storageSnapshot()).toEqual({});

    act(() => result.current.toggle());
    expect(result.current.theme).toBe("light");
    expect(storageSnapshot()).toEqual({ [KEY]: "light" });

    act(() => result.current.toggle());
    expect(result.current.theme).toBe("dark");
    expect(storageSnapshot()).toEqual({ [KEY]: "dark" });
  });

  it("restores a toggled choice on the next visit, in the hook and the pre-paint script", () => {
    const first = renderHook(() => useTheme());
    expect(first.result.current.theme).toBe("dark");
    act(() => first.result.current.toggle());
    first.unmount();

    const { prePaintLight, view } = firstPaintAndHook();
    expect(view.result.current.theme).toBe("light");
    expect(prePaintLight).toBe(true);
  });

  it("still resolves and toggles when storage throws", () => {
    const proto = Object.getPrototypeOf(localStorage) as Storage;
    const saved = { get: proto.getItem, set: proto.setItem, remove: proto.removeItem };
    const boom = () => {
      throw new Error("SecurityError");
    };
    proto.getItem = boom;
    proto.setItem = boom;
    proto.removeItem = boom;
    try {
      const { result } = renderHook(() => useTheme());
      expect(result.current.theme).toBe("dark");
      act(() => result.current.toggle());
      expect(result.current.theme).toBe("light");
    } finally {
      proto.getItem = saved.get;
      proto.setItem = saved.set;
      proto.removeItem = saved.remove;
    }
  });
});
