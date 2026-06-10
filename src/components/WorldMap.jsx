// src/components/WorldMap.jsx
// Uses d3-geo + topojson-client directly - no React 18 wrapper dependency
import { useEffect, useRef, useState, useCallback } from "react";
import { geoNaturalEarth1, geoPath } from "d3-geo";
import { feature } from "topojson-client";
import { scaleLinear } from "d3-scale";
import { zoom, zoomIdentity } from "d3-zoom";
import { select } from "d3-selection";
import isoCountries from "i18n-iso-countries";
import { sentimentBucket } from "../lib/sentiment";

const GEO_URL =
  "https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json";

// Derive ISO numeric → alpha-2 from i18n-iso-countries so every country in the
// topojson resolves, not just a hardcoded subset. The library expects the
// numeric code without leading zeros (e.g. "76" → "BR"), so strip padding.
const numericToAlpha2 = (numId) =>
  isoCountries.numericToAlpha2(String(parseInt(numId, 10)));

// For MultiPolygon countries (France, USA, Russia, etc.) the full-feature
// centroid is pulled toward distant overseas territories. Use the largest
// sub-polygon's centroid instead so the label lands on the main landmass.
function dominantCentroid(pathGen, feature) {
  const { geometry } = feature;
  if (geometry?.type !== "MultiPolygon") return pathGen.centroid(feature);
  let best = null;
  let bestArea = -Infinity;
  for (const coords of geometry.coordinates) {
    const poly = { type: "Feature", geometry: { type: "Polygon", coordinates: coords } };
    const area = pathGen.area(poly);
    if (area > bestArea) { bestArea = area; best = poly; }
  }
  return best ? pathGen.centroid(best) : pathGen.centroid(feature);
}

const colorScale = scaleLinear()
  .domain([-1, -0.1, 0, 0.1, 1]) // Narrow neutral zone to emphasise positive & negative colours
  .range(["#ff0000", "#ffbb00", "#ffff00", "#bcff00", "#00ff00"])
  .clamp(true);

export function WorldMap({ byCode, selectedCountry, onSelectCountry, sentimentFilter = "all" }) {
  const svgRef = useRef(null);
  const gRef = useRef(null); // the <g> we apply zoom transforms to
  const [countries, setCountries] = useState([]);
  const [paths, setPaths] = useState({}); // { numericId: svgPathString }
  const [centroids, setCentroids] = useState({}); // { numericId: [x, y] }
  const [areas, setAreas] = useState({}); // { numericId: projectedAreaPx² }
  const [zoomK, setZoomK] = useState(1); // current d3-zoom scale factor
  const [tooltip, setTooltip] = useState(null); // { x, y, name, score }

  // Re-derive the projected path strings for the SVG's current size. Pulled out
  // of the loader so we can re-run it on resize / orientation change.
  const projectFeatures = useCallback((features) => {
    const svgEl = svgRef.current;
    const width = svgEl?.clientWidth || 960;
    const height = svgEl?.clientHeight || 500;
    const fc = { type: "FeatureCollection", features };

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
    // instead of the mid-Atlantic.
    const FOCUS = [22, 35]; // [lon, lat]
    const [fx, fy] = projection(FOCUS);
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

    const pathGen = geoPath(projection);

    const computed = {};
    const computedCentroids = {};
    const computedAreas = {};
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
  }, []);

  // -- Load & project topojson ------------------------------------------------
  useEffect(() => {
    let cancelled = false;

    async function load() {
      const res = await fetch(GEO_URL);
      const topo = await res.json();
      if (cancelled) return;

      const { features } = feature(topo, topo.objects.countries);
      setCountries(features);
      projectFeatures(features);
    }

    load();
    return () => { cancelled = true; };
  }, [projectFeatures]);

  // -- Reproject on container resize (orientation change, window resize) -------
  useEffect(() => {
    if (!svgRef.current || countries.length === 0) return;

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
  }, [countries, projectFeatures]);

  // -- d3-zoom setup ---------------------------------------------------------
  useEffect(() => {
    if (!svgRef.current || !gRef.current) return;

    const svgSel = select(svgRef.current);
    const gSel = select(gRef.current);

    const zoomBehavior = zoom()
      .scaleExtent([1, 8])
      .on("zoom", (event) => {
        gSel.attr("transform", event.transform);
        setZoomK(event.transform.k);
      });

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
  }, [countries.length]); // re-attach once countries are loaded

  // -- Hover tooltip handler -------------------------------------------------
  const handleMouseMove = useCallback((e, name, score) => {
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
          {/* Country paths */}
          {countries.map((f, i) => {
            if (f.id == null) return null;
            const numId = String(f.id).padStart(3, "0");
            const alpha2 = numericToAlpha2(numId);
            const countryData = alpha2 ? byCode[alpha2] : null;
            const score = countryData?.score;
            const hasData = score !== undefined && score !== null;
            const isSelected = alpha2 && selectedCountry?.code?.toUpperCase() === alpha2;
            // Dim countries that don't match the active sentiment filter so the
            // matching ones stand out. Unscored countries are dimmed too while filtering.
            const dimmed =
              sentimentFilter !== "all" &&
              (!hasData || sentimentBucket(score) !== sentimentFilter);
            const d = paths[numId];
            if (!d) return null;

            return (
              <path
                key={`${numId}-${i}`}
                d={d}
                strokeWidth={0.4}
                style={{
                  // fill/stroke/opacity via CSS so var() theme tokens resolve.
                  fill: isSelected ? "#3b82f6" : (hasData ? colorScale(score) : "var(--map-empty)"),
                  stroke: "rgb(var(--bg-rgb))",
                  opacity: dimmed ? "var(--map-dimmed-opacity)" : isSelected ? 1 : 0.88,
                  cursor: hasData ? "pointer" : "default",
                  filter: isSelected
                    ? "brightness(1.3) drop-shadow(0 0 5px rgb(var(--fg-rgb)/0.5))"
                    : undefined,
                  transition: "opacity 0.15s, filter 0.15s",
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  if (hasData && countryData) onSelectCountry(countryData);
                }}
                onMouseMove={(e) =>
                  handleMouseMove(e, countryData?.name ?? numId, score)
                }
                onMouseEnter={(e) =>
                  handleMouseMove(e, countryData?.name ?? numId, score)
                }
                onMouseLeave={handleMouseLeave}
              />
            );
          })}
          {/* Country name labels - zoom-aware: only shown when the country is
              visually large enough (area × k² > threshold). Font size shrinks
              with zoom so labels stay a constant visual size. */}
          {(() => {
            const AREA_THRESHOLD = 1500; // minimum visual area (px²) to show a label
            return countries.map((f) => {
              if (f.id == null) return null;
              const numId = String(f.id).padStart(3, "0");
              const alpha2 = numericToAlpha2(numId);
              const centroid = centroids[numId];
              if (!centroid || !alpha2) return null;
              // Only render when the country is visually large enough at current zoom
              if ((areas[numId] ?? 0) * zoomK * zoomK < AREA_THRESHOLD) return null;
              const name =
                byCode[alpha2]?.name ?? isoCountries.getName(alpha2, "en");
              if (!name) return null;
              return (
                <text
                  key={`label-${numId}`}
                  x={centroid[0]}
                  y={centroid[1]-1}
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
              );
            });
          })()}
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
              style={{
                color:
                  tooltip.score > 0.1
                    ? "#00dd00"
                    : tooltip.score < -0.1
                    ? "#ff0000"
                    : "#F3B120",
              }}
            >
              {tooltip.score >= 0 ? "+" : ""}
              {tooltip.score.toFixed(2)}
            </span>
          )}
        </div>
      )}

      {/* Zoom hint */}
      {countries.length > 0 && (
        <p className="absolute bottom-20 right-4 sm:bottom-2 text-[10px] opacity-60 pointer-events-none text-right">
          <span className="md:hidden">Pinch to zoom · Double-tap to reset</span>
          <span className="hidden md:inline">Scroll to zoom · Double-click to reset</span>
        </p>
      )}
    </div>
  );
}