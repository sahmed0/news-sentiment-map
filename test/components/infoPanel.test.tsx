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

  it("describes the pipeline the code actually runs", () => {
    render(<InfoPanel open={true} onClose={() => {}} />);
    const pipeline = screen.getByText(/news headlines are fetched per country/).textContent ?? "";

    expect(pipeline).toContain("Up to 5 news headlines");
    expect(pipeline).toContain("GNews (which ranks stories by popularity)");
    expect(pipeline).toContain("most recent headlines");
    expect(pipeline).not.toContain("most popular news headlines");
    expect(pipeline).not.toContain("± 2 hours");
    expect(pipeline).toContain("staleness backfill");
    expect(pipeline).toContain("edge cache");
  });

  it("states the score's standard error in the sentiment section", () => {
    render(<InfoPanel open={true} onClose={() => {}} />);
    expect(screen.getByText(/cardiffnlp/, { selector: "a" }).parentElement?.textContent).toContain(
      "standard error of roughly ±0.19",
    );
  });
});
