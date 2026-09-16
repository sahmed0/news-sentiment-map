// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { createRef } from "react";
import { render, cleanup, act } from "@testing-library/react";
import { WorldMap, type WorldMapHandle } from "../../src/components/WorldMap.js";
import type { CountryResult } from "../../shared/types";

const BY_CODE: Record<string, CountryResult> = {
  US: { code: "us", name: "United States", score: 0.3, status: "ok", articles: [], fetchedAt: "2026-01-01T00:00:00.000Z" },
  FR: { code: "fr", name: "France", score: -0.2, status: "ok", articles: [], fetchedAt: "2026-01-01T00:00:00.000Z" },
};

afterEach(cleanup);

describe("WorldMap", () => {
  it("projects the bundled topology into country paths", () => {
    const { container } = render(
      <WorldMap byCode={BY_CODE} selectedCode={null} onSelectCountry={() => {}} />,
    );
    expect(container.querySelectorAll("path").length).toBeGreaterThan(100);
  });

  // The time scrubber and search share one ref. Two useImperativeHandle
  // calls on the same ref would leave only the last one's methods, so assert the
  // whole surface rather than each feature's own method in isolation.
  it("exposes the whole handle - scrub painting and the search camera move", () => {
    const ref = createRef<WorldMapHandle>();
    render(
      <WorldMap
        byCode={BY_CODE}
        selectedCode={null}
        onSelectCountry={() => {}}
        handleRef={ref}
      />,
    );

    expect(typeof ref.current?.paintScores).toBe("function");
    expect(typeof ref.current?.releaseScores).toBe("function");
    expect(typeof ref.current?.focusCountry).toBe("function");

    // A scrub frame paints fills straight to the DOM and flags the svg.
    act(() => ref.current?.paintScores({ US: 0.5, FR: null }));
    expect(document.querySelector("svg")?.classList.contains("map-scrubbing")).toBe(true);
    act(() => ref.current?.releaseScores());
    expect(document.querySelector("svg")?.classList.contains("map-scrubbing")).toBe(false);
  });

  it("exposes a focusCountry handle that tolerates unknown and known codes", () => {
    const ref = createRef<WorldMapHandle>();
    render(
      <WorldMap
        byCode={BY_CODE}
        selectedCode={null}
        onSelectCountry={() => {}}
        handleRef={ref}
      />,
    );

    expect(typeof ref.current?.focusCountry).toBe("function");
    // An unknown alpha-2 is a silent no-op; a known one pans/zooms the map.
    act(() => {
      ref.current?.focusCountry("ZZ");
      ref.current?.focusCountry("us");
    });
  });
});
