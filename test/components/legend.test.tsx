// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll, afterAll } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { Legend } from "../../src/components/Legend.js";
import { legendGradientCss } from "../../src/lib/sentiment.js";
import type { CountryResult } from "../../shared/types";

const country = (
  code: string,
  name: string,
  score: number | null,
  fetchedAt = "2026-07-21T17:30:00.000Z"
): CountryResult => ({ code, name, score, status: "ok", articles: [], fetchedAt });

// Pin the process to a non-UTC zone for this file. Without it the freshness
// assertion below would also pass on a machine that happens to run in UTC even
// if the component stopped asking for UTC.
const realTz = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "America/New_York"; // UTC-4 in July
});
afterAll(() => {
  process.env.TZ = realTz;
});

afterEach(cleanup);

describe("Legend freshness line", () => {
  it("renders the newest fetchedAt as a UTC time, not a local one", () => {
    render(
      <Legend
        data={[
          country("us", "United States", 0.4, "2026-07-20T09:00:00.000Z"),
          country("fr", "France", -0.2, "2026-07-21T17:30:00.000Z"),
        ]}
        lastUpdated={null}
        fromCache={false}
      />
    );

    // 17:30Z is 13:30 in the stubbed local zone; the label says UTC, so the
    // number beside it must be the UTC one.
    expect(screen.getByText(/Updated on/).textContent).toBe(
      "Updated on 21 July 2026 at 17:30 UTC"
    );
  });

  it("falls back to the client's own fetch time when no country carries one", () => {
    render(
      <Legend
        data={[country("us", "United States", 0.4, "")]}
        lastUpdated={new Date("2026-07-21T17:30:00.000Z")}
        fromCache={true}
      />
    );

    expect(screen.queryByText(/Updated on/)).toBeNull();
    expect(screen.getByText(/Cached ·/)).toBeTruthy();
  });

  it("renders no freshness line at all with no data and no client time", () => {
    render(<Legend data={[]} lastUpdated={null} fromCache={false} />);

    expect(screen.queryByText(/Updated/)).toBeNull();
  });
});

describe("Legend rankings", () => {
  it("lists the most positive and most negative countries with their scores", () => {
    render(
      <Legend
        data={[
          country("us", "United States", 0.4),
          country("fr", "France", -0.6),
          country("de", "Germany", 0.9),
          country("jp", "Japan", null),
        ]}
        lastUpdated={null}
        fromCache={false}
      />
    );

    expect(screen.getByText("Most positive")).toBeTruthy();
    expect(screen.getByText("+0.90")).toBeTruthy();
    expect(screen.getByText("-0.60")).toBeTruthy();
    // Unscored countries appear in neither list.
    expect(screen.queryByText("Japan")).toBeNull();
  });

  it("hides the rankings block when nothing is scored", () => {
    render(
      <Legend data={[country("jp", "Japan", null)]} lastUpdated={null} fromCache={false} />
    );

    expect(screen.queryByText("Most positive")).toBeNull();
    expect(screen.queryByText("Most negative")).toBeNull();
  });
});

describe("Legend ramp", () => {
  it("paints the shared sentiment gradient", () => {
    const { container } = render(
      <Legend data={[]} lastUpdated={null} fromCache={false} />
    );

    const ramp = container.querySelector<HTMLElement>(".h-2.rounded-full");
    // jsdom re-serialises hex colors as rgb(), so compare against the shared
    // gradient converted the same way rather than against a second literal.
    const asRgb = (css: string) =>
      css.replace(/#([0-9a-f]{6})/gi, (_, hex: string) => {
        const n = parseInt(hex, 16);
        return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
      });
    expect(ramp?.style.background).toBe(asRgb(legendGradientCss()));
  });
});
