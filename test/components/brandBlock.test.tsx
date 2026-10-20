// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { BrandBlock } from "../../src/components/BrandBlock.js";

afterEach(cleanup);

describe("BrandBlock", () => {
  it("renders the title", () => {
    render(<BrandBlock />);

    expect(screen.getByText("World News Sentiment")).toBeTruthy();
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
