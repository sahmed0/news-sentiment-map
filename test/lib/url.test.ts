import { describe, it, expect } from "vitest";
import { safeHttpUrl } from "../../src/lib/url.js";

describe("safeHttpUrl", () => {
  it("passes through https URLs unchanged", () => {
    expect(safeHttpUrl("https://example.com/article")).toBe("https://example.com/article");
  });

  it("passes through http URLs unchanged", () => {
    expect(safeHttpUrl("http://example.com/article")).toBe("http://example.com/article");
  });

  it("rejects javascript: URLs", () => {
    expect(safeHttpUrl("javascript:alert(1)")).toBeNull();
  });

  it("rejects unparseable garbage strings", () => {
    expect(safeHttpUrl("not a url")).toBeNull();
  });

  it("rejects null and undefined", () => {
    expect(safeHttpUrl(null)).toBeNull();
    expect(safeHttpUrl(undefined)).toBeNull();
  });
});
