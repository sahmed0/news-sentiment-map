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

  // jsdom doesn't know how to measure SVG elements, so `svg.width` is normally
  // undefined here. d3-zoom reads that width every time a zoom starts,
  // even a code-triggered one like WorldMap's focusCountry animation, and
  // crashes when it's undefined. That crash happens in a delayed callback, so
  // if the test file finishes before the 700ms animation does, it shows up
  // later as a confusing unhandled error instead of a normal test failure.
  // Fix: give the SVG element a real width/height so the crash never happens.
  const svgProto = window.SVGSVGElement?.prototype;
  if (svgProto && !("width" in svgProto)) {
    for (const dim of ["width", "height"] as const) {
      Object.defineProperty(svgProto, dim, {
        configurable: true,
        get(this: SVGSVGElement) {
          const attr = Number(this.getAttribute(dim));
          const value = Number.isFinite(attr) && attr > 0
            ? attr
            : (dim === "width" ? this.clientWidth : this.clientHeight) || 0;
          return { baseVal: { value }, animVal: { value } };
        },
      });
    }
  }
}
