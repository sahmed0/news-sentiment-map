// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { Sheet } from "../../src/components/Sheet.js";

afterEach(cleanup);

describe("Sheet", () => {
  it("renders nothing when closed", () => {
    render(
      <Sheet open={false} onClose={() => {}} title="Filter by sentiment">
        <p>content</p>
      </Sheet>
    );

    expect(screen.queryByText("content")).toBeNull();
    expect(screen.queryByText("Filter by sentiment")).toBeNull();
  });

  it("renders the title and children when open", () => {
    render(
      <Sheet open={true} onClose={() => {}} title="Filter by sentiment">
        <p>content</p>
      </Sheet>
    );

    expect(screen.getByText("Filter by sentiment")).toBeTruthy();
    expect(screen.getByText("content")).toBeTruthy();
  });

  it("calls onClose when the close button is pressed", () => {
    const onClose = vi.fn();
    render(
      <Sheet open={true} onClose={onClose} title="Legend & rankings">
        <p>content</p>
      </Sheet>
    );

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
