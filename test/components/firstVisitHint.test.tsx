// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { FirstVisitHint } from "../../src/components/FirstVisitHint.js";

// framer-motion calls matchMedia once and then only listens to that query's
// "change" event, so replacing window.matchMedia later has no effect. Install
// the mock once; tests flip `reduced` and fire the stored listeners instead.
let reduced = false;
const changeListeners = new Set<() => void>();
window.matchMedia = ((query: string) => {
  if (!query.includes("prefers-reduced-motion")) {
    return {
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    } as unknown as MediaQueryList;
  }
  return {
    get matches() {
      return reduced;
    },
    media: query,
    onchange: null,
    addEventListener: (_type: string, cb: () => void) => changeListeners.add(cb),
    removeEventListener: (_type: string, cb: () => void) => changeListeners.delete(cb),
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  } as unknown as MediaQueryList;
}) as unknown as typeof window.matchMedia;

// Call before render(): each new instance reads the preference on first render.
const setReducedMotion = (value: boolean) => {
  reduced = value;
  changeListeners.forEach((cb) => cb());
};

afterEach(cleanup);

describe("FirstVisitHint", () => {
  it("renders nothing when hidden", () => {
    render(<FirstVisitHint show={false} onDismiss={() => {}} />);
    expect(screen.queryByText("Click any country to see its headlines")).toBeNull();
  });

  it("shows the pulse dot by default", () => {
    render(<FirstVisitHint show={true} onDismiss={() => {}} />);
    expect(document.querySelector(".animate-ping")).toBeTruthy();
  });

  it("stops the pulse under reduced motion but keeps the hint usable", () => {
    setReducedMotion(true);
    render(<FirstVisitHint show={true} onDismiss={() => {}} />);
    expect(document.querySelector(".animate-ping")).toBeNull();
    expect(screen.getByText("Click any country to see its headlines")).toBeTruthy();
  });
});
