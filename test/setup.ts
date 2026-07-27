// Browser APIs jsdom does not implement, stubbed once for every jsdom test file.
// Guarded on `window` because this file also loads for the node-environment
// api/ tests, which must keep running against a bare Node global.
if (typeof window !== "undefined") {
  // useMediaQuery asks for this on mount. Reporting "no match" puts components
  // on their desktop branch.
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }

  // WorldMap observes its <svg> to reproject on resize. A no-op observer is
  // enough: the component projects once explicitly on mount for exactly this
  // reason, so nothing depends on the observer ever firing.
  if (!window.ResizeObserver) {
    window.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
}
