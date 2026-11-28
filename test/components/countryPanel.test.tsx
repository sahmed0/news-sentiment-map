// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { Article, CountryResult, HistoryPoint } from "../../shared/types";

// Both data hooks are mocked: an unmocked fetch resolving after a test would
// raise an act() warning, and mocking lets each state be set directly.
vi.mock("../../src/hooks/useCountryHistory.js", () => ({
  useCountryHistory: vi.fn(() => ({ points: [], loading: false })),
}));
vi.mock("../../src/hooks/useCountryHeadlines.js", () => ({
  useCountryHeadlines: vi.fn(),
}));

import { useCountryHistory } from "../../src/hooks/useCountryHistory.js";
import { useCountryHeadlines, type UseCountryHeadlines } from "../../src/hooks/useCountryHeadlines.js";
import { CountryPanel } from "../../src/components/CountryPanel.js";

const COUNTRY: CountryResult = {
  code: "us",
  name: "United States",
  score: 0.25,
  status: "ok",
  articles: [],
  fetchedAt: "2026-07-22T00:00:00.000Z",
};

// A rising series a week apart, so computeDelta7d has a point to compare with.
const series = (scores: number[]): HistoryPoint[] =>
  scores.map((score, i) => ({ date: `2026-07-${String(i + 1).padStart(2, "0")}`, score, n: 4 }));

const mockHistory = (points: HistoryPoint[], loading = false) =>
  vi.mocked(useCountryHistory).mockReturnValue({ points, loading });

// Returns the retry spy so a test can assert Try again calls it.
const mockHeadlines = (status: UseCountryHeadlines["status"], byDate: Record<string, Article[]> = {}) => {
  const retry = vi.fn();
  vi.mocked(useCountryHeadlines).mockReturnValue({ status, byDate: new Map(Object.entries(byDate)), retry });
  return retry;
};

// matchMedia (which the panel asks for to pick its layout) is stubbed globally
// in test/setup.ts.
beforeEach(() => {
  vi.mocked(useCountryHistory).mockReset();
  vi.mocked(useCountryHeadlines).mockReset();
  mockHeadlines("idle");
});
afterEach(cleanup);

describe("CountryPanel history section", () => {
  it("shows the sparkline and the 7-day delta once enough days exist", () => {
    // 8 daily points: the latest (0.40) against the point seven days back
    // (0.10) gives +0.30.
    mockHistory(series([0.1, 0.15, 0.2, 0.2, 0.25, 0.3, 0.35, 0.4]));
    const { container } = render(<CountryPanel country={COUNTRY} onClose={() => {}} />);

    expect(screen.getByText("30-day trend")).toBeTruthy();
    expect(container.querySelector("svg polyline")).toBeTruthy();
    expect(screen.getByText(/7d/).textContent?.replace(/\s+/g, " ")).toBe("7d ▲ +0.30");
    expect(screen.queryByText(/We don't have enough data/)).toBeNull();
    // Caption: earliest scored day (Jul 1, +0.10) on the left, current (Jul 8, +0.40) on the right.
    expect(screen.getByText("Jul 1").querySelector("span")?.textContent).toBe("+0.10");
    expect(screen.getByText("Jul 8").querySelector("span")?.textContent).toBe("+0.40");
  });

  it("marks a fall with a down arrow and a minus sign", () => {
    mockHistory(series([0.5, 0.4, 0.3, 0.3, 0.2, 0.2, 0.1, 0.05]));
    render(<CountryPanel country={COUNTRY} onClose={() => {}} />);

    expect(screen.getByText(/7d/).textContent?.replace(/\s+/g, " ")).toBe("7d ▼ −0.45");
  });

  it("shows the accumulation note, and no chart, below three points", () => {
    mockHistory(series([0.1, 0.2]));
    const { container } = render(<CountryPanel country={COUNTRY} onClose={() => {}} />);

    expect(
      screen.getByText("We don't have enough data to show a history trend for this country yet."),
    ).toBeTruthy();
    expect(container.querySelector("svg polyline")).toBeNull();
    // No chip either - two points can't describe a week.
    expect(screen.queryByText(/7d/)).toBeNull();
  });

  it("treats an empty series like a cold start rather than an error", () => {
    mockHistory([]);
    render(<CountryPanel country={COUNTRY} onClose={() => {}} />);

    expect(
      screen.getByText("We don't have enough data to show a history trend for this country yet."),
    ).toBeTruthy();
  });

  it("renders no history markup at all while loading, so the panel can't jump", () => {
    mockHistory([], true);
    const { container } = render(<CountryPanel country={COUNTRY} onClose={() => {}} />);

    expect(screen.queryByText("30-day trend")).toBeNull();
    expect(screen.queryByText(/We don't have enough data/)).toBeNull();
    expect(container.querySelector("svg polyline")).toBeNull();
    // The rest of the panel is unaffected - the section appears in place below.
    expect(screen.getByText("United States")).toBeTruthy();
    expect(screen.getByText("Headlines")).toBeTruthy();
  });

  it("asks for the selected country's code", () => {
    mockHistory([]);
    render(<CountryPanel country={COUNTRY} onClose={() => {}} />);

    expect(vi.mocked(useCountryHistory).mock.calls[0][0]).toBe("us");
  });
});

describe("CountryPanel historical mode", () => {
  const PAST = [
    article({ title: "Archived good", url: "https://example.com/p1", score: 0.6 }),
    article({ title: "Archived bad", url: "https://example.com/p2", score: -0.6 }),
  ];
  const TODAY = { ...COUNTRY, articles: [article({ title: "Today only", url: "https://example.com/t" })] };
  const renderPast = (historical: NonNullable<Parameters<typeof CountryPanel>[0]["historical"]>, country = TODAY) => {
    mockHistory([]);
    return render(<CountryPanel country={country} onClose={() => {}} historical={historical} />);
  };
  const label = () => screen.getByText(/^Headlines/).textContent;

  it("enables the archive only off the live day, including scoreless past days", () => {
    mockHistory([]);
    render(<CountryPanel country={TODAY} onClose={() => {}} />);
    expect(label()).toBe("Headlines");
    expect(screen.getByText("Today only")).toBeTruthy();
    expect(vi.mocked(useCountryHeadlines)).toHaveBeenLastCalledWith("us", false);
    cleanup();

    renderPast({ date: "2026-08-14", score: null });
    expect(vi.mocked(useCountryHeadlines)).toHaveBeenLastCalledWith("us", true);
  });

  it("says nothing was scored on a past day with no score, with no list", () => {
    mockHeadlines("ready", { "2026-08-14": PAST });
    renderPast({ date: "2026-08-14", score: null });

    expect(screen.getByText("No headlines were scored for United States on 14 August 2026.")).toBeTruthy();
    expect(screen.queryByText(/^Headlines/)).toBeNull();
    expect(screen.queryByText("Archived good")).toBeNull();
  });

  it("shows a loading status while the archive is fetched, with the day's score", () => {
    mockHeadlines("loading");
    renderPast({ date: "2026-08-14", score: -0.42 });

    expect(screen.getByRole("status").textContent).toBe("Loading headlines…");
    expect(screen.queryByText("Today only")).toBeNull();
    // U+2212, the panel's minus sign, not a hyphen.
    expect(screen.getByText(/Negative \(−0\.42/)).toBeTruthy();
  });

  it("offers Try again on a failed fetch, keeping the score and the carried note", () => {
    const retry = mockHeadlines("error");
    renderPast({ date: "2026-08-14", score: -0.42, carried: true, measuredOn: "2026-08-12" });

    const status = screen.getByRole("status");
    expect(status.textContent).toContain("Couldn't load saved headlines.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Negative \(−0\.42/)).toBeTruthy();
    expect(screen.getByText(/showing its most recent earlier day, 12 August 2026\./)).toBeTruthy();
  });

  it("lists the day's archived headlines under a dated label, with no carried note", () => {
    mockHeadlines("ready", { "2026-08-14": PAST, "2026-08-13": [article({ title: "Wrong day" })] });
    renderPast({ date: "2026-08-14", score: 0.1, carried: false });

    expect(label()).toBe("Headlines · Aug 14");
    expect(screen.getByText("Archived good")).toBeTruthy();
    expect(screen.getByText("Archived bad")).toBeTruthy();
    expect(screen.queryByText("Wrong day")).toBeNull();
    expect(screen.queryByText("Today only")).toBeNull();
    expect(screen.queryByText(/No headlines were scored for this country/)).toBeNull();
  });

  it("renders past-day items without the entry animation", () => {
    mockHeadlines("ready", { "2026-08-14": PAST });
    const past = renderPast({ date: "2026-08-14", score: 0.1 });
    expect(past.container.querySelector("li")?.getAttribute("style") ?? "").not.toContain("opacity: 0");
    cleanup();

    mockHistory([]);
    const live = render(<CountryPanel country={TODAY} onClose={() => {}} />);
    expect(live.container.querySelector("li")?.getAttribute("style")).toContain("opacity: 0");
  });

  it("shows a carried day's source-day headlines under the source date", () => {
    mockHeadlines("ready", { "2026-08-12": PAST, "2026-08-14": [article({ title: "Wrong day" })] });
    renderPast({ date: "2026-08-14", score: 0.1, carried: true, measuredOn: "2026-08-12" });

    expect(
      screen.getByText(
        "No headlines were scored for this country on 14 August 2026; showing its most recent earlier day, 12 August 2026.",
      ),
    ).toBeTruthy();
    expect(label()).toBe("Headlines · Aug 12");
    expect(screen.getByText("Archived good")).toBeTruthy();
    expect(screen.queryByText("Wrong day")).toBeNull();
  });

  it("says the source day wasn't saved when a carried day's source has no archive", () => {
    mockHeadlines("ready", {});
    renderPast({ date: "2026-08-14", score: 0.1, carried: true, measuredOn: "2026-08-12" });

    expect(screen.getByText(/showing its most recent earlier day, 12 August 2026\./)).toBeTruthy();
    expect(screen.getByText("Headlines from 12 August 2026 weren't saved, so only the score is shown.")).toBeTruthy();
  });

  it("falls back to the short carried note and the day's own message without a source date", () => {
    mockHeadlines("ready", { "2026-08-14": PAST });
    renderPast({ date: "2026-08-14", score: 0.1, carried: true });

    expect(
      screen.getByText(
        "No headlines were scored for this country on 14 August 2026; showing its most recent earlier score.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Headlines from 14 August 2026 weren't saved, so only the score is shown.")).toBeTruthy();
    expect(screen.queryByText("Archived good")).toBeNull();
  });

  it("keeps the filter across days and resets it on a new country", () => {
    const filter = (name: string) => screen.getByRole("button", { name: new RegExp(`^${name}`) });
    mockHeadlines("ready", {
      "2026-08-14": PAST,
      "2026-08-15": [article({ title: "Next good", score: 0.7 }), article({ title: "Next bad", score: -0.7 })],
    });
    mockHistory([]);
    const { rerender } = render(
      <CountryPanel country={TODAY} onClose={() => {}} historical={{ date: "2026-08-14", score: 0.1 }} />,
    );
    fireEvent.click(filter("Negative"));
    expect(screen.queryByText("Archived good")).toBeNull();

    rerender(<CountryPanel country={TODAY} onClose={() => {}} historical={{ date: "2026-08-15", score: 0.1 }} />);
    expect(screen.getByText("Next bad")).toBeTruthy();
    expect(screen.queryByText("Next good")).toBeNull();

    rerender(
      <CountryPanel
        country={{ ...TODAY, code: "fr", name: "France" }}
        onClose={() => {}}
        historical={{ date: "2026-08-15", score: 0.1 }}
      />,
    );
    // The old panel is still exiting with its Negative filter, so only the new
    // one can be showing "Next good".
    expect(screen.getByText("Next good")).toBeTruthy();
    expect(screen.getAllByText("Next bad")).toHaveLength(2);
  });
});

const article = (over: Partial<Article> = {}): Article => ({
  title: "A headline",
  url: "https://example.com/a",
  publishedAt: "2026-07-20T10:00:00.000Z",
  language: "english",
  score: 0.5,
  translatedTitle: null,
  ...over,
});

const withArticles = (articles: Article[]): CountryResult => ({ ...COUNTRY, articles });

const renderPanel = (articles: Article[]) => {
  mockHistory([]);
  return render(<CountryPanel country={withArticles(articles)} onClose={() => {}} />);
};

describe("CountryPanel original-language line", () => {
  it("shows the original title when the translation genuinely differs", () => {
    renderPanel([article({ title: "Der Himmel ist blau", translatedTitle: "The sky is blue" })]);

    expect(screen.getByText("The sky is blue")).toBeTruthy();
    expect(screen.getByText(/Original:/).textContent).toBe("Original: Der Himmel ist blau");
  });

  it.each([
    ["no translation", null],
    ["an empty translation", ""],
  ])("shows the untranslated title and no original line with %s", (_label, translatedTitle) => {
    renderPanel([article({ title: "A headline", translatedTitle })]);

    expect(screen.getByText("A headline")).toBeTruthy();
    expect(screen.queryByText(/Original:/)).toBeNull();
  });

  it("shows no original line for a whitespace-only translation", () => {
    const { container } = renderPanel([
      article({ title: "A headline", translatedTitle: "   " }),
    ]);

    expect(screen.queryByText(/Original:/)).toBeNull();
    // Documents current behavior, which is not ideal: a whitespace-only
    // translation is truthy, so it wins over the original title and the
    // headline renders blank. Never observed in production data (Azure returns
    // either a translation or nothing), so it is recorded, not fixed here.
    expect(container.querySelector("a")?.textContent?.trim()).toBe("");
  });

  it("shows no original line when the translation only differs in case and spacing", () => {
    // Azure echoes English headlines back, sometimes with cosmetic differences;
    // repeating the same sentence twice would just be noise.
    renderPanel([article({ title: "The Sky Is Blue", translatedTitle: "  the sky is blue " })]);

    expect(screen.queryByText(/Original:/)).toBeNull();
  });
});

describe("CountryPanel headlines list", () => {
  const MIXED = [
    article({ title: "Good news", url: "https://example.com/1", score: 0.6 }),
    article({ title: "Better news", url: "https://example.com/2", score: 0.4 }),
    article({ title: "Flat news", url: "https://example.com/3", score: 0 }),
    article({ title: "Bad news", url: "https://example.com/4", score: -0.7 }),
  ];

  // By role, not by text: the SentimentBar above the list renders its own
  // "Positive (+0.25)" label, which a bare text query would also match.
  const filter = (label: string) =>
    screen.getByRole("button", { name: new RegExp(`^${label}`) });

  it("counts each bucket, and counts every article under All", () => {
    renderPanel(MIXED);

    expect(filter("All").textContent).toBe("All 4");
    expect(filter("Positive").textContent).toBe("Positive 2");
    expect(filter("Neutral").textContent).toBe("Neutral 1");
    expect(filter("Negative").textContent).toBe("Negative 1");
  });

  it("shows only the matching headlines once a filter is picked, and restores them", () => {
    renderPanel(MIXED);

    fireEvent.click(filter("Positive"));
    expect(screen.getByText("Good news")).toBeTruthy();
    expect(screen.getByText("Better news")).toBeTruthy();
    expect(screen.queryByText("Flat news")).toBeNull();
    expect(screen.queryByText("Bad news")).toBeNull();

    fireEvent.click(filter("All"));
    expect(screen.getByText("Bad news")).toBeTruthy();
  });

  it("explains an empty filter result differently from an empty country", () => {
    renderPanel([article({ title: "Good news", score: 0.6 })]);
    fireEvent.click(filter("Negative"));
    expect(screen.getByText("No headlines match this filter.")).toBeTruthy();

    cleanup();

    renderPanel([]);
    expect(screen.getByText("No headlines available.")).toBeTruthy();
  });

  it("leaves unscored headlines out of every bucket but still lists them", () => {
    renderPanel([article({ title: "Unscored", score: null })]);

    expect(filter("All").textContent).toBe("All 1");
    expect(filter("Positive").textContent).toBe("Positive 0");
    expect(screen.getByText("Unscored")).toBeTruthy();
  });

  it("renders a hostile URL as plain text instead of a link", () => {
    renderPanel([
      article({ title: "Trap", url: "javascript:alert(1)" }),
      article({ title: "Safe", url: "https://example.com/safe" }),
    ]);

    expect(screen.getByText("Trap").tagName).toBe("SPAN");
    const safe = screen.getByText("Safe");
    expect(safe.tagName).toBe("A");
    expect(safe.getAttribute("href")).toBe("https://example.com/safe");
    expect(safe.getAttribute("rel")).toBe("noopener noreferrer");
  });
});

describe("CountryPanel uncertainty", () => {
  const scored = (scores: number[]) => scores.map((score, i) => article({ url: `https://example.com/${i}`, score }));

  // Live day: spread comes from the headlines.
  const renderLive = (score: number, scores: number[]) => {
    mockHistory([]);
    return render(
      <CountryPanel country={{ ...COUNTRY, score, articles: scored(scores) }} onClose={() => {}} />,
    );
  };

  const renderDay = (points: HistoryPoint[], historical: { date: string; score: number; carried?: boolean }) => {
    mockHistory(points);
    return render(<CountryPanel country={COUNTRY} onClose={() => {}} historical={historical} />);
  };

  // The whole score line, e.g. "Negative (−0.20 ± 0.13)".
  const scoreLine = () =>
    screen.getByTitle("Mean of this country's headline scores, from −1 to +1").textContent;
  const caveat = () => screen.queryByText(/Not distinguishable from/);
  const notRecorded = () => screen.queryByText(/Spread was not recorded/);
  const CARRIED = "No headlines were scored for this country on 22 September 2026; showing its most recent earlier score.";

  it("shows the interval and the headline count for a live day with 5 headlines", () => {
    // mean 0.40, sd 0.158, se 0.071
    renderLive(0.4, [0.6, 0.5, 0.4, 0.3, 0.2]);

    expect(scoreLine()).toBe("Positive (+0.40 ± 0.07)");
    expect(screen.getByText("mean of 5 headlines · ±1 standard error")).toBeTruthy();
    // The interval's own tooltip says it is not a guarantee.
    expect(screen.getByTitle(/about two times in three/).textContent?.trim()).toBe("± 0.07");
  });

  it("counts the headlines actually scored, not a literal 5, when fewer came back", () => {
    renderLive(-0.2, [-0.3, -0.2, -0.1]);

    expect(screen.getByText("mean of 3 headlines · ±1 standard error")).toBeTruthy();
    expect(screen.queryByText(/mean of 5/)).toBeNull();
  });

  it("says a negative country is not distinguishable from neutral when its interval reaches it", () => {
    // mean −0.20, se 0.130 → [−0.33, −0.07]
    renderLive(-0.2, [-0.6, -0.4, -0.1, 0.1, 0]);

    expect(scoreLine()).toBe("Negative (−0.20 ± 0.13)");
    expect(caveat()?.textContent).toBe("Not distinguishable from neutral at this sample size.");
  });

  it("names both neighbours for a neutral country whose interval reaches both", () => {
    // mean 0.08, se 0.185 → [−0.105, 0.265]: neutral, reaching negative and positive.
    renderLive(0.08, [0.55, 0.4, 0.1, -0.2, -0.45]);

    expect(scoreLine()).toBe("Neutral (+0.08 ± 0.18)");
    expect(caveat()?.textContent).toBe(
      "Not distinguishable from negative or positive at this sample size.",
    );
  });

  it("shows no caveat when the interval sits comfortably inside one band", () => {
    renderLive(0.8, [0.85, 0.8, 0.8, 0.75, 0.8]);

    expect(scoreLine()).toBe("Very Positive (+0.80 ± 0.02)");
    expect(caveat()).toBeNull();
  });

  it("shows no interval for a single headline, and says why", () => {
    renderLive(-0.42, [-0.42]);

    expect(scoreLine()).toBe("Negative (−0.42)");
    expect(screen.getByText("from 1 headline · spread not available")).toBeTruthy();
    expect(caveat()).toBeNull();
  });

  it("shows the stored interval on a past day that has sd", () => {
    // se = 0.2 / sqrt(5) = 0.089
    renderDay([{ date: "2026-09-20", score: -0.2, n: 5, sd: 0.2 }], { date: "2026-09-20", score: -0.2 });

    expect(scoreLine()).toBe("Negative (−0.20 ± 0.09)");
    expect(screen.getByText("mean of 5 headlines · ±1 standard error")).toBeTruthy();
    expect(notRecorded()).toBeNull();
  });

  it("shows n and the not-recorded note, and no interval, on a past day without sd", () => {
    renderDay(
      [
        { date: "2026-09-19", score: 0.3, n: 4 },
        { date: "2026-09-25", score: 0.2, n: 5, sd: 0.2 },
      ],
      { date: "2026-09-19", score: 0.3 },
    );

    expect(scoreLine()).toBe("Positive (+0.30)");
    expect(screen.getByText("mean of 4 headlines")).toBeTruthy();
    // The date is the earliest point that does carry sd, not a hard-coded one.
    expect(notRecorded()?.textContent).toBe(
      "Spread was not recorded before 25 September 2026, so no interval is shown for this day.",
    );
    expect(caveat()).toBeNull();
  });

  it("shows a carried day's source interval, labelled with the source date", () => {
    renderDay(
      [
        { date: "2026-09-18", score: 0.1, n: 5, sd: 0.3 },
        { date: "2026-09-21", score: -0.3, n: 5, sd: 0.2 },
      ],
      { date: "2026-09-22", score: -0.3, carried: true },
    );

    expect(scoreLine()).toBe("Negative (−0.30 ± 0.09)");
    expect(screen.getByText("measured Sep 21 · mean of 5 headlines · ±1 standard error")).toBeTruthy();
    expect(screen.getByText(CARRIED)).toBeTruthy();
    expect(notRecorded()).toBeNull();
  });

  it.each([
    ["the source point's score differs", [{ date: "2026-09-21", score: -0.31, n: 5, sd: 0.2 }]],
    ["there is no earlier point", [{ date: "2026-09-23", score: -0.3, n: 5, sd: 0.2 }]],
  ])("shows no interval and no n on a carried day when %s", (_label, points) => {
    renderDay(points, { date: "2026-09-22", score: -0.3, carried: true });

    expect(scoreLine()).toBe("Negative (−0.30)");
    expect(screen.queryByText(/headlines? ·|mean of/)).toBeNull();
    expect(screen.queryByText(/measured/)).toBeNull();
    expect(notRecorded()).toBeNull();
    expect(screen.getByText(CARRIED)).toBeTruthy();
  });

  it("shows n and the not-recorded note on a carried day whose source has no sd", () => {
    renderDay(
      [
        { date: "2026-09-21", score: -0.3, n: 4 },
        { date: "2026-09-26", score: 0.1, n: 5, sd: 0.2 },
      ],
      { date: "2026-09-22", score: -0.3, carried: true },
    );

    expect(scoreLine()).toBe("Negative (−0.30)");
    expect(screen.getByText("measured Sep 21 · mean of 4 headlines")).toBeTruthy();
    expect(notRecorded()?.textContent).toBe(
      "Spread was not recorded before 26 September 2026, so no interval is shown for this day.",
    );
    expect(screen.getByText(CARRIED)).toBeTruthy();
  });
});
