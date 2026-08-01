// src/components/WorldMap.tsx
// Uses d3-geo + topojson-client directly
import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { geoNaturalEarth1, geoPath } from "d3-geo";
import { feature } from "topojson-client";
import { zoom, zoomIdentity, type ZoomBehavior, type D3ZoomEvent } from "d3-zoom";
import { select } from "d3-selection";
import isoCountries from "i18n-iso-countries";
import topo from "world-atlas/countries-110m.json";
import { bucketColor } from "../lib/sentiment";
import { numericToAlpha2, dominantCentroid } from "../lib/geo";
import { CountryPaths } from "./CountryPaths";
import type { CountryResult, FilterKey } from "../../shared/types";
import type { Feature, FeatureCollection } from "geojson";
import type { Topology, GeometryCollection } from "topojson-specification";

// A JSON import is inferred structurally, so assert the shape feature() needs.
const world = topo as unknown as Topology<{ countries: GeometryCollection }>;

const countries = feature(world, world.objects.countries).features as Feature[];

interface WorldMapProps {
  byCode: Record<string, CountryResult>;
  selectedCode: string | null; // UPPERCASE alpha-2 of the selected country, or null
  onSelectCountry: (country: CountryResult) => void;
  sentimentFilter?: FilterKey;
}

// Placed country label after collision filtering.
interface LabelCandidate {
  numId: string;
  centroid: [number, number];
  name: string;
  area: number;
}

export function WorldMap({ byCode, selectedCode, onSelectCountry, sentimentFilter = "all" }: WorldMapProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const gRef = useRef<SVGGElement | null>(null); // the <g> we apply zoom transforms to
  const zoomBehaviorRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null); // d3-zoom behavior, so resize can update its extent
  const [paths, setPaths] = useState<Record<string, string | null>>({}); // { numericId: svgPathString }
  const [centroids, setCentroids] = useState<Record<string, [number, number]>>({}); // { numericId: [x, y] }
  const [areas, setAreas] = useState<Record<string, number>>({}); // { numericId: projectedAreaPx² }
  const [zoomK, setZoomK] = useState(1); // current d3-zoom scale factor
  const [tooltip, setTooltip] = useState<
    { x: number; y: number; name: string; score: number | null | undefined } | null
  >(null);

  // Re-derive the projected path strings for the SVG's current size. Pulled out
  // of the loader so we can re-run it on resize / orientation change.
  const projectFeatures = useCallback((features: Feature[]) => {
    const svgEl = svgRef.current;
    const width = svgEl?.clientWidth || 960;
    const height = svgEl?.clientHeight || 500;
    const fc: FeatureCollection = { type: "FeatureCollection", features };

    // Start from a fit-inside projection, then scale up so the map *covers* the
    // viewport - filling whichever dimension fitSize left short and cropping the
    // overflow. fitSize alone fits the whole world inside the box, which leaves
    // empty bands (and looks too zoomed out) on non-2:1 viewports.
    const projection = geoNaturalEarth1().fitSize([width, height], fc);

    const [[x0, y0], [x1, y1]] = geoPath(projection).bounds(fc);
    const coverScale = Math.max(width / (x1 - x0), height / (y1 - y0));
    projection.scale(projection.scale() * coverScale);

    // Anchor the view on Europe / North Africa / Middle East rather than the
    // whole-world centroid, so the cropped mobile slice lands on dense landmass
    // instead of the mid-Atlantic. projection() returns null for unprojectable
    // input; [22,35] is a valid lon/lat so this always resolves, but guard for strictness.
    const FOCUS: [number, number] = [22, 35]; // [lon, lat]
    const focus = projection(FOCUS);
    if (focus) {
      const [fx, fy] = focus;
      const [t0x, t0y] = projection.translate();
      let nx = t0x + width / 2 - fx;
      let ny = t0y + height / 2 - fy;

      // Clamp the focal offset so the map still fully covers the viewport - no
      // empty gutters where it has been cropped.
      projection.translate([nx, ny]);
      const [[bx0, by0], [bx1, by1]] = geoPath(projection).bounds(fc);
      if (bx0 > 0) nx -= bx0;
      else if (bx1 < width) nx += width - bx1;
      if (by0 > 0) ny -= by0;
      else if (by1 < height) ny += height - by1;
      projection.translate([nx, ny]);
    }

    const pathGen = geoPath(projection);

    const computed: Record<string, string | null> = {};
    const computedCentroids: Record<string, [number, number]> = {};
    const computedAreas: Record<string, number> = {};
    features.forEach((f) => {
      if (f.id == null) return;
      const id = String(f.id).padStart(3, "0");
      computed[id] = pathGen(f);
      const c = dominantCentroid(pathGen, f);
      if (!isNaN(c[0]) && !isNaN(c[1])) computedCentroids[id] = c;
      computedAreas[id] = pathGen.area(f);
    });
    setPaths(computed);
    setCentroids(computedCentroids);
    setAreas(computedAreas);

    // Keep the pan clamp in sync with the (possibly resized) viewport. The map
    // covers [0,0] → [width, height]; pad the extent by a full viewport on each
    // side of those bounds (equal on all sides) so a generous drag into empty
    // space is allowed - needed for usable dragging on narrow mobile screens.
    zoomBehaviorRef.current?.translateExtent([
      [-width, -height],
      [width * 2, height * 2],
    ]);
  }, []);

  // -- Project the (static) topojson once the SVG has been laid out -----------
  // The ResizeObserver below also fires on observe, but not in environments
  // that lack it (jsdom), so the initial projection is explicit.
  useEffect(() => {
    projectFeatures(countries);
  }, [projectFeatures]);

  // -- Reproject on container resize (orientation change, window resize) -------
  useEffect(() => {
    if (!svgRef.current) return;

    let frame = 0;
    const ro = new ResizeObserver(() => {
      // Coalesce bursts of resize events into a single reprojection.
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => projectFeatures(countries));
    });
    ro.observe(svgRef.current);

    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
    };
  }, [projectFeatures]);

  // -- d3-zoom setup ---------------------------------------------------------
  useEffect(() => {
    if (!svgRef.current || !gRef.current) return;

    const svgSel = select(svgRef.current);
    const gSel = select(gRef.current);

    const { clientWidth: w, clientHeight: h } = svgRef.current;
    const zoomBehavior = zoom<SVGSVGElement, unknown>()
      .scaleExtent([1, 8])
      // Clamp panning so the map (which fills [0,0] → [w,h]) can't be dragged
      // too far off. Pad by a full viewport on each side of those bounds (equal
      // on all sides) so a generous drag into empty space is allowed -
      // otherwise dragging is unusable on narrow mobile screens.
      .translateExtent([[-w, -h], [w * 2, h * 2]])
      .on("zoom", (event: D3ZoomEvent<SVGSVGElement, unknown>) => {
        gSel.attr("transform", event.transform.toString());
        setZoomK(event.transform.k);
      });
    zoomBehaviorRef.current = zoomBehavior;

    svgSel.call(zoomBehavior);

    // Double-click to reset
    svgSel.on("dblclick.zoom", () => {
      svgSel.transition().duration(500).call(
        zoomBehavior.transform,
        zoomIdentity
      );
    });

    return () => {
      svgSel.on(".zoom", null);
    };
  }, []);

  // -- Hover tooltip handler -------------------------------------------------
  const handleMouseMove = useCallback((e: React.MouseEvent, name: string, score: number | null | undefined) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    setTooltip({
      x: e.clientX - rect.left + 12,
      y: e.clientY - rect.top - 28,
      name,
      score,
    });
  }, []);

  const handleMouseLeave = useCallback(() => {
    setTooltip(null);
  }, []);

  // Greedy collision-filtered labels: largest countries placed first; a candidate
  // is skipped if its estimated bbox overlaps any already-placed label.
  // All measurements are in SVG coordinate space (pre-zoom), so screen-pixel
  // estimates are divided by zoomK to convert.
  const visibleLabels = useMemo(() => {
    const AREA_THRESHOLD = 1500;
    const CHAR_W = 5.5;  // estimated screen px per character at 10px font
    const PAD_H = 4;     // horizontal clearance per side (screen px)
    const PAD_V = 3;     // vertical clearance per side (screen px)

    const svgCharW = CHAR_W / zoomK;
    const svgH = 14 / zoomK;      // label box height in SVG units
    const svgPadH = PAD_H / zoomK;
    const svgPadV = PAD_V / zoomK;

    const candidates = countries
      .map((f): LabelCandidate | null => {
        if (f.id == null) return null;
        const numId = String(f.id).padStart(3, "0");
        const alpha2 = numericToAlpha2(numId);
        const centroid = centroids[numId];
        if (!centroid || !alpha2) return null;
        const area = areas[numId] ?? 0;
        if (area * zoomK * zoomK < AREA_THRESHOLD) return null;
        const name = byCode[alpha2]?.name ?? isoCountries.getName(alpha2, "en");
        if (!name) return null;
        return { numId, centroid, name, area };
      })
      .filter((c) => c !== null)
      .sort((a, b) => b.area - a.area); // largest country wins on conflict

    const placed: { x1: number; y1: number; x2: number; y2: number }[] = [];
    const visible: LabelCandidate[] = [];

    for (const c of candidates) {
      const w = c.name.length * svgCharW + svgPadH * 2;
      const h = svgH + svgPadV * 2;
      const [cx, cy] = c.centroid;
      const bbox = { x1: cx - w / 2, y1: cy - h / 2, x2: cx + w / 2, y2: cy + h / 2 };

      const overlaps = placed.some(
        p => bbox.x1 < p.x2 && bbox.x2 > p.x1 && bbox.y1 < p.y2 && bbox.y2 > p.y1
      );

      if (!overlaps) {
        placed.push(bbox);
        visible.push(c);
      }
    }

    return visible;
  }, [centroids, areas, zoomK, byCode]); // `countries` is module-scope static data

  return (
    <div className="relative w-full h-full">
      <svg
        ref={svgRef}
        className="w-full h-full"
        // touch-action:none lets d3-zoom own pinch/drag gestures instead of the
        // browser scrolling/zooming the page underneath the map.
        style={{ cursor: "grab", touchAction: "none" }}
      >
        <g ref={gRef}>
          {/* Country paths - memoized so a zoom gesture, which re-renders this
              component on every frame via zoomK, doesn't redraw ~155 paths. */}
          <CountryPaths
            features={countries}
            paths={paths}
            byCode={byCode}
            selectedCode={selectedCode}
            sentimentFilter={sentimentFilter}
            onSelectCountry={onSelectCountry}
            onHover={handleMouseMove}
            onHoverEnd={handleMouseLeave}
          />
          {/* Country name labels — collision-filtered by visibleLabels memo.
              Labels are sorted largest-first so big countries always win when
              two candidates' bboxes overlap. */}
          {visibleLabels.map(({ numId, centroid, name }) => (
            <text
              key={`label-${numId}`}
              x={centroid[0]}
              y={centroid[1] - 1}
              textAnchor="middle"
              dominantBaseline="middle"
              fontSize={10 / zoomK}
              pointerEvents="none"
              style={{
                fill: "black",
                stroke: "rgba(255,255,255)",
                strokeWidth: 0.75 / zoomK,
                paintOrder: "stroke fill",
                fontFamily: "sans-serif",
                fontWeight: 600,
                letterSpacing: "0.01em",
                userSelect: "none",
              }}
            >
              {name}
            </text>
          ))}
        </g>
      </svg>

      {/* Tooltip */}
      {tooltip && (
        <div
          className="pointer-events-none absolute z-10 rounded-lg px-2.5 py-1.5 text-xs font-medium"
          style={{
            left: tooltip.x,
            top: tooltip.y,
            background: "rgb(var(--panel-rgb) / 0.9)",
            border: "1px solid rgb(var(--fg-rgb) / 0.1)",
            backdropFilter: "blur(8px)",
            color: "rgb(var(--fg-rgb))",
            whiteSpace: "nowrap",
          }}
        >
          <span className="opacity-70">{tooltip.name}</span>
          {tooltip.score !== undefined && tooltip.score !== null && (
            <span
              className="ml-2 font-bold"
              style={{ color: bucketColor(tooltip.score) ?? undefined }}
            >
              {tooltip.score >= 0 ? "+" : ""}
              {tooltip.score.toFixed(2)}
            </span>
          )}
        </div>
      )}

      {/* Zoom hint - the topology is bundled, so the map is never empty. */}
      <p className="absolute bottom-20 right-4 sm:bottom-2 mb-[env(safe-area-inset-bottom)] text-[10px] opacity-60 pointer-events-none text-right">
        <span className="md:hidden">Pinch to zoom · Double-tap to reset</span>
        <span className="hidden md:inline">Scroll to zoom · Double-click to reset</span>
      </p>
    </div>
  );
}