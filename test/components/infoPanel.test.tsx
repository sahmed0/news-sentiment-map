// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { InfoPanel } from "../../src/components/InfoPanel.js";

afterEach(cleanup);

describe("InfoPanel", () => {
  it("renders nothing when closed", () => {
    render(<InfoPanel open={false} onClose={() => {}} />);
    expect(screen.queryByText("World News Sentiment")).toBeNull();
  });

  it("documents how the timeline behaves", () => {
    render(<InfoPanel open={true} onClose={() => {}} />);

    expect(screen.getByText("Reading the timeline")).toBeTruthy();
    const body = screen.getByText(/scrubs back through the last 30 days/);
    expect(body.textContent).toContain("every 2 days");
    expect(body.textContent).toContain("up to 3 days");
    expect(body.textContent).toContain("only kept for the current day");
  });
});
