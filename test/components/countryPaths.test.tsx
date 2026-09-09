// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { Feature } from "geojson";
import type { CountryResult } from "../../shared/types";

// CountryPaths calls numericToAlpha2 exactly once per feature while rendering,
// so spying on it counts render passes through the memo boundary without
// instrumenting the component itself.
vi.mock("../../src/lib/geo.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/geo.js")>();
  return { ...actual, numericToAlpha2: vi.fn(actual.numericToAlpha2) };
});

import { numericToAlpha2 } from "../../src/lib/geo.js";
import { scoreColor } from "../../src/lib/sentiment.js";
import { CountryPaths } from "../../src/components/CountryPaths.js";

// Two synthetic features - the real 110m topology would only slow the test down;
// CountryPaths reads nothing but `id` off them.
const FEATURES: Feature[] = [
  { type: "Feature", id: "840", properties: null, geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } },
  { type: "Feature", id: "076", properties: null, geometry: { type: "Polygon", coordinates: [[[2, 2], [3, 2], [3, 3], [2, 2]]] } },
];
const PATHS = { "840": "M0,0L1,0L1,1Z", "076": "M2,2L3,2L3,3Z" };
const BY_CODE: Record<string, CountryResult> = {
  US: { code: "us", name: "United States", score: 0.4, status: "ok", articles: [], fetchedAt: "2026-07-21T00:00:00.000Z" },
  BR: { code: "br", name: "Brazil", score: -0.3, status: "ok", articles: [], fetchedAt: "2026-07-21T00:00:00.000Z" },
};
const noop = () => {};

// Module-scope so every prop CountryPaths receives is referentially stable
// across the harness's re-renders - exactly how WorldMap/App supply them.
function Harness({ selectedCode }: { selectedCode: string | null }) {
  const [zoomK, setZoomK] = useState(1); // stands in for WorldMap's zoom state
  return (
    <div>
      <button onClick={() => setZoomK((k) => k + 1)}>zoom</button>
      <svg>
        <g>
          <CountryPaths
            features={FEATURES}
            paths={PATHS}
            byCode={BY_CODE}
            selectedCode={selectedCode}
            sentimentFilter="all"
            onSelectCountry={noop}
            onHover={noop}
            onHoverEnd={noop}
          />
          <text data-testid="zoomk">{zoomK}</text>
        </g>
      </svg>
    </div>
  );
}

const renderPasses = () => vi.mocked(numericToAlpha2).mock.calls.length / FEATURES.length;

afterEach(() => {
  cleanup();
  vi.mocked(numericToAlpha2).mockClear();
});

describe("CountryPaths memoization", () => {
  it("does not re-render the paths when only the zoom state changes", () => {
    render(<Harness selectedCode={null} />);
    expect(renderPasses()).toBe(1);
    expect(document.querySelectorAll("path")).toHaveLength(2);

    for (let i = 0; i < 3; i++) fireEvent.click(screen.getByText("zoom"));

    // The parent really did re-render three times...
    expect(screen.getByTestId("zoomk").textContent).toBe("4");
    // ...but the path layer was skipped every time.
    expect(renderPasses()).toBe(1);
  });

  it("still re-renders when a prop it depends on changes", () => {
    const { rerender } = render(<Harness selectedCode={null} />);
    expect(renderPasses()).toBe(1);

    rerender(<Harness selectedCode="US" />);

    // Guards against the memo test above passing vacuously (e.g. if the spy
    // were wired to a module the component doesn't actually use).
    expect(renderPasses()).toBe(2);
  });
});

describe("CountryPaths scrubbed-day override", () => {
  const render1 = (scores?: Record<string, number | null>) =>
    render(
      <svg>
        <g>
          <CountryPaths
            features={FEATURES}
            paths={PATHS}
            byCode={BY_CODE}
            selectedCode={null}
            sentimentFilter="all"
            scores={scores}
            onSelectCountry={noop}
            onHover={noop}
            onHoverEnd={noop}
          />
        </g>
      </svg>,
    );

  const fillOf = (code: string) =>
    (document.querySelector(`path[data-code="${code}"]`) as SVGPathElement).style.fill;

  it("fills from `scores`, not byCode, when the prop is present", () => {
    render1({ US: -0.9 });

    // byCode has US at +0.40; the override wins.
    expect(fillOf("US")).toBe(scoreColor(-0.9));
    expect(fillOf("US")).not.toBe(scoreColor(0.4));
    // Brazil is absent from the override -> treated as unscored that day.
    expect(fillOf("BR")).toBe("var(--map-empty)");
  });

  it("falls back to byCode fills when no `scores` prop is given", () => {
    render1(undefined);

    expect(fillOf("US")).toBe(scoreColor(0.4));
    expect(fillOf("BR")).toBe(scoreColor(-0.3));
  });
});
