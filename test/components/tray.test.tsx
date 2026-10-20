// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { Tray } from "../../src/components/Tray.js";

afterEach(cleanup);

describe("Tray", () => {
  it("renders its children in a dialog named by the label, with no visible title", () => {
    render(
      <Tray onClose={() => {}} label="Filter by sentiment">
        <p>content</p>
      </Tray>
    );

    expect(screen.getByRole("dialog", { name: "Filter by sentiment" })).toBeTruthy();
    expect(screen.getByText("content")).toBeTruthy();
    expect(screen.queryByText("Filter by sentiment")).toBeNull();
  });

  it("calls onClose when the close button is pressed", () => {
    const onClose = vi.fn();
    render(
      <Tray onClose={onClose} label="Legend & rankings">
        <p>content</p>
      </Tray>
    );

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
