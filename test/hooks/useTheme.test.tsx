// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useTheme } from "../../src/hooks/useTheme.js";

afterEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.classList.remove("theme-light");
});

describe("useTheme", () => {
  it("defaults to dark without saving anything", () => {
    const { result } = renderHook(() => useTheme());

    expect(result.current.theme).toBe("dark");
    expect(document.documentElement.classList.contains("theme-light")).toBe(false);
    expect(localStorage.length).toBe(0);
  });

  it("ignores the old key, which saved the light default on every visit", () => {
    localStorage.setItem("nsm-theme", "light");
    const { result } = renderHook(() => useTheme());

    expect(result.current.theme).toBe("dark");
  });

  it("saves an explicit toggle and restores it next visit", () => {
    const first = renderHook(() => useTheme());
    act(() => first.result.current.toggle());

    expect(first.result.current.theme).toBe("light");
    expect(document.documentElement.classList.contains("theme-light")).toBe(true);
    first.unmount();

    const second = renderHook(() => useTheme());
    expect(second.result.current.theme).toBe("light");
  });
});
