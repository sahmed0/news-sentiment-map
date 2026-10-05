// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { CountrySearch } from "../../src/components/CountrySearch.js";
import type { CountryResult } from "../../shared/types";

const mk = (code: string, name: string, score: number | null = 0.2): CountryResult => ({
  code,
  name,
  score,
  status: "ok",
  articles: [],
  fetchedAt: "2026-01-01T00:00:00.000Z",
});

const BY_CODE: Record<string, CountryResult> = {
  US: mk("us", "United States"),
  GB: mk("gb", "United Kingdom"),
  FR: mk("fr", "France"),
};

// matchMedia is stubbed to "no match" by test/setup, so this renders the
// desktop overlay branch, not the mobile Sheet.
function Harness({ onSelect = vi.fn() }: { onSelect?: (c: CountryResult) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>opener</button>
      <CountrySearch byCode={BY_CODE} open={open} onOpenChange={setOpen} onSelect={onSelect} />
    </>
  );
}

afterEach(cleanup);

describe("CountrySearch", () => {
  it("opens on Ctrl/⌘-K from anywhere", () => {
    render(<Harness />);
    expect(screen.queryByRole("combobox")).toBeNull();

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });

    expect(screen.getByRole("combobox")).toBeTruthy();
  });

  it("filters the list as you type", () => {
    render(<Harness />);
    fireEvent.click(screen.getByText("opener"));

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "france" } });

    expect(screen.getByRole("option", { name: /France/ })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /United States/ })).toBeNull();
  });

  it("selects the active option with Arrow-Down then Enter", () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    fireEvent.click(screen.getByText("opener"));

    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "united" } });
    // Two covered hits, alphabetical: United Kingdom (0), United States (1).
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0]).toMatchObject({ code: "us" });
  });

  it("closes on Escape and restores focus to the opener", () => {
    render(<Harness />);
    const opener = screen.getByText("opener");
    opener.focus();
    fireEvent.click(opener);

    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });

    // The panel plays an exit animation before it unmounts, so assert the
    // observable effect of the close: focus returns to the element that opened it.
    expect(document.activeElement).toBe(opener);
  });

  it("does not select an uncovered 'No data' row", () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    fireEvent.click(screen.getByText("opener"));

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "fiji" } });
    const row = screen.getByRole("option", { name: /Fiji/ });
    expect(row.getAttribute("aria-disabled")).toBe("true");

    fireEvent.click(row);

    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole("combobox")).toBeTruthy(); // still open
  });
});
