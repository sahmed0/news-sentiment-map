// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { MobileToolbar, type MobileToolbarItem } from "../../src/components/MobileToolbar.js";

// useIsMobile reads matchMedia on mount; the shared test stub always reports
// "no match" (desktop), so mobile-specific tests must override it themselves.
const realMatchMedia = window.matchMedia;
beforeEach(() => {
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
});
afterEach(() => {
  window.matchMedia = realMatchMedia;
  cleanup();
});

function items(overrides: Partial<MobileToolbarItem> = {}): MobileToolbarItem[] {
  return [
    { key: "filter", label: "Filter", icon: <span>F</span>, onPress: vi.fn(), ...overrides },
    { key: "legend", label: "Legend", icon: <span>L</span>, onPress: vi.fn() },
  ];
}

describe("MobileToolbar", () => {
  it("renders one button per item", () => {
    render(<MobileToolbar items={items()} />);

    expect(screen.getByRole("button", { name: /Filter/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Legend/ })).toBeTruthy();
  });

  it("calls onPress when a button is pressed", () => {
    const list = items();
    render(<MobileToolbar items={list} />);

    fireEvent.click(screen.getByRole("button", { name: /Filter/ }));
    expect(list[0].onPress).toHaveBeenCalledTimes(1);
    expect(list[1].onPress).not.toHaveBeenCalled();
  });

  it("shows the badge dot only when badge is true", () => {
    const { container, rerender } = render(<MobileToolbar items={items({ badge: false })} />);
    expect(container.querySelector('[aria-hidden="true"]')).toBeNull();

    rerender(<MobileToolbar items={items({ badge: true })} />);
    expect(container.querySelector('[aria-hidden="true"]')).toBeTruthy();
  });
});
