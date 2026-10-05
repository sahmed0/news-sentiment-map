// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { TimeScrubber } from "../../src/components/TimeScrubber.js";

const DAYS = [
  "2026-08-08", "2026-08-09", "2026-08-10", "2026-08-11",
  "2026-08-12", "2026-08-13", "2026-08-14", "2026-08-15",
];
const LAST = DAYS.length - 1;

const noop = () => {};
const slider = () => screen.getByRole("slider") as HTMLInputElement;
const liveButton = () => screen.getByRole("button", { name: "Live" }) as HTMLButtonElement;

afterEach(cleanup);

describe("TimeScrubber", () => {
  it("shows the current day as a short date and announces the full date", () => {
    render(<TimeScrubber days={DAYS} value={6} onPreview={noop} onCommit={noop} />);

    expect(screen.getByText("Aug 14")).toBeTruthy();
    expect(slider().getAttribute("aria-valuetext")).toBe("14 August 2026");
  });

  it("calls onPreview while dragging and onCommit only on release", () => {
    const onPreview = vi.fn();
    const onCommit = vi.fn();
    render(<TimeScrubber days={DAYS} value={0} onPreview={onPreview} onCommit={onCommit} />);

    fireEvent.change(slider(), { target: { value: "3" } });
    expect(onPreview).toHaveBeenCalledWith(3);
    expect(onCommit).not.toHaveBeenCalled();

    fireEvent.keyUp(slider());
    expect(onCommit).toHaveBeenCalledWith(3);
  });

  it("commits the latest day when LIVE is pressed, and disables it on the last day", () => {
    const onCommit = vi.fn();
    const { rerender } = render(
      <TimeScrubber days={DAYS} value={3} onPreview={noop} onCommit={onCommit} />,
    );

    expect(liveButton().disabled).toBe(false);
    fireEvent.click(liveButton());
    expect(onCommit).toHaveBeenCalledWith(LAST);

    rerender(<TimeScrubber days={DAYS} value={LAST} onPreview={noop} onCommit={onCommit} />);
    expect(liveButton().disabled).toBe(true);
  });

  it("advances a day per tick during autoplay and leaves no timer after pause", () => {
    vi.useFakeTimers();
    try {
      const onCommit = vi.fn();
      function Harness() {
        const [v, setV] = useState(0);
        return (
          <TimeScrubber
            days={DAYS}
            value={v}
            onPreview={noop}
            onCommit={(i) => { onCommit(i); setV(i); }}
          />
        );
      }
      render(<Harness />);

      fireEvent.click(screen.getByRole("button", { name: "Play" }));
      act(() => { vi.advanceTimersByTime(300); });
      expect(onCommit).toHaveBeenLastCalledWith(1);
      act(() => { vi.advanceTimersByTime(300); });
      expect(onCommit).toHaveBeenLastCalledWith(2);

      fireEvent.click(screen.getByRole("button", { name: "Pause" }));
      onCommit.mockClear();
      act(() => { vi.advanceTimersByTime(3000); });
      expect(onCommit).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops autoplay at the last day", () => {
    vi.useFakeTimers();
    try {
      const onCommit = vi.fn();
      function Harness() {
        const [v, setV] = useState(LAST - 1);
        return (
          <TimeScrubber
            days={DAYS}
            value={v}
            onPreview={noop}
            onCommit={(i) => { onCommit(i); setV(i); }}
          />
        );
      }
      render(<Harness />);

      fireEvent.click(screen.getByRole("button", { name: "Play" }));
      act(() => { vi.advanceTimersByTime(300); });
      expect(onCommit).toHaveBeenLastCalledWith(LAST);

      onCommit.mockClear();
      act(() => { vi.advanceTimersByTime(3000); });
      expect(onCommit).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
