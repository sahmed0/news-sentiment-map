// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { SentimentFilter } from "../../src/components/SentimentFilter.js";
import { SENTIMENT_FILTERS, BUCKET_COLOR, ALL_ACCENT } from "../../src/lib/sentiment.js";
import type { FilterKey } from "../../shared/types";

const COUNTS: Record<FilterKey, number> = { all: 7, positive: 3, neutral: 2, negative: 2 };

const buttons = () => screen.getAllByRole("button");

afterEach(cleanup);

describe("SentimentFilter", () => {
  it("renders one option per shared filter definition, in order", () => {
    render(<SentimentFilter value="all" onChange={() => {}} />);

    expect(buttons().map((b) => b.textContent)).toEqual(
      SENTIMENT_FILTERS.map((f) => f.label)
    );
  });

  it("appends the counts when given, and shows bare labels when not", () => {
    const { rerender } = render(
      <SentimentFilter value="all" onChange={() => {}} counts={COUNTS} />
    );
    expect(buttons().map((b) => b.textContent)).toEqual([
      "All 7",
      "Positive 3",
      "Neutral 2",
      "Negative 2",
    ]);

    rerender(<SentimentFilter value="all" onChange={() => {}} />);
    expect(buttons().map((b) => b.textContent)).toEqual([
      "All",
      "Positive",
      "Neutral",
      "Negative",
    ]);
  });

  it("reports the picked key to onChange", () => {
    const onChange = vi.fn();
    render(<SentimentFilter value="all" onChange={onChange} />);

    fireEvent.click(screen.getByText("Negative"));
    fireEvent.click(screen.getByText("Positive"));

    expect(onChange.mock.calls.map(([key]) => key)).toEqual(["negative", "positive"]);
  });

  it("accents only the active option, and moves the accent when value changes", () => {
    const { rerender } = render(<SentimentFilter value="all" onChange={() => {}} />);

    const [all, positive] = buttons();
    expect(all.style.color).toBe(ALL_ACCENT);
    expect(all.style.border).not.toBe("1px solid transparent");
    expect(positive.style.color).toBe("rgb(var(--fg-rgb) / 0.65)");
    expect(positive.style.border).toBe("1px solid transparent");

    rerender(<SentimentFilter value="positive" onChange={() => {}} />);

    const [allAgain, positiveAgain] = buttons();
    expect(positiveAgain.style.color).toBe(BUCKET_COLOR.positive);
    expect(positiveAgain.style.background).toBe("rgb(var(--c-positive-rgb) / 0.13)");
    expect(allAgain.style.border).toBe("1px solid transparent");
  });

  it("keeps the caller's extra classes on the row", () => {
    const { container } = render(
      <SentimentFilter value="all" onChange={() => {}} className="mb-3" />
    );

    expect(container.firstElementChild?.className).toContain("mb-3");
  });
});
