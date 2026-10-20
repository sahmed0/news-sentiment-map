// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { BrandBlock } from "../../src/components/BrandBlock.js";

afterEach(cleanup);

describe("BrandBlock", () => {
  it("keeps the title as a screen-reader-only heading", () => {
    render(<BrandBlock />);

    const title = screen.getByRole("heading", { level: 1, name: "World News Sentiment" });
    expect(title.className).toContain("sr-only");
  });

  it("draws no card when there is nothing to put in it", () => {
    const { container } = render(<BrandBlock />);

    expect(container.querySelector("div")).toBeNull();
  });

  it("renders children into the slot", () => {
    render(
      <BrandBlock>
        <p>Today's summary</p>
      </BrandBlock>
    );

    expect(screen.getByText("Today's summary")).toBeTruthy();
  });
});
