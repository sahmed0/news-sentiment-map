// The eval's Azure requests, which are where the first live run went wrong: a rate
// limit produced empty translations, those cached as if they were real, and the
// language then reported zero drift. The cases below cause loud failures.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  preflightAzure,
  resetAzureRateLimit,
  translateTo,
  translateToEnglish,
  type PipelineOptions,
} from "../../eval/pipeline.js";

let dir: string;
let opts: PipelineOptions;

// Azure's translate response shape: one document per input.
const azureOk = (texts: string[]): Response =>
  new Response(JSON.stringify(texts.map((text) => ({ translations: [{ text }] }))), { status: 200 });

// `retry-after: 0` keeps the backoff path under test without a real wait.
const azure429 = (): Response =>
  new Response(
    JSON.stringify({ error: { code: 429001, message: "The server rejected the request because the client has exceeded request limits." } }),
    { status: 429, headers: { "retry-after": "0" } },
  );

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eval-pipeline-"));
  opts = { cacheDir: dir, gapMs: 0, azureGapMs: 0 };
  resetAzureRateLimit();
  // Budget far higher than any test payload, so pacing never adds a real wait here;
  // the limiter's own behaviour is covered in its dedicated case.
  vi.stubEnv("AZURE_CHARS_PER_MINUTE", "100000000");
  vi.stubEnv("AZURE_TRANSLATOR_KEY", "test-key");
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("translateTo (English -> language)", () => {
  it("retries a 429 and caches only the successful result", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(azure429())
      .mockResolvedValueOnce(azureOk(["Bonjour"]));
    vi.stubGlobal("fetch", fetchMock);

    expect(await translateTo(["Hello"], "fr", opts)).toEqual(["Bonjour"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it("throws after exhausting retries and caches nothing", async () => {
    const fetchMock = vi.fn().mockResolvedValue(azure429());
    vi.stubGlobal("fetch", fetchMock);

    await expect(translateTo(["Hello"], "de", opts)).rejects.toThrow(/HTTP 429/);
    // A cached failure would be served forever, with no request left to notice it.
    expect(readdirSync(dir)).toEqual([]);
  });

  it("does not retry a failure that waiting cannot fix", async () => {
    // 401 is a bad key and 403 an exhausted quota; sleeping three times first
    // just delays the same error.
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(translateTo(["Hello"], "ja", opts)).rejects.toThrow(/HTTP 401/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a response whose length does not match the batch", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(azureOk(["only one"])));
    await expect(translateTo(["a", "b"], "pt", opts)).rejects.toThrow(/unexpected response shape/);
  });
});

describe("translateToEnglish (production translateAll)", () => {
  it("passes a successful batch straight through", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(azureOk(["Hello", "World"])));
    expect(await translateToEnglish(["Bonjour", "Monde"], opts)).toEqual(["Hello", "World"]);
  });

  it("retries the swallowed failure and caches the eventual success", async () => {
    // The production translateAll has no retry of its own and hides the 429 as
    // "", so the eval must both detect the degrade AND retry it, or a single
    // rate-limit blip loses the whole language. Backoff here is minutes, so drive
    // it with fake timers rather than waiting.
    vi.useFakeTimers();
    try {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(azure429())
        .mockResolvedValueOnce(azureOk(["Hello", "World"]));
      vi.stubGlobal("fetch", fetchMock);

      const promise = translateToEnglish(["Bonjour", "Monde"], opts);
      await vi.runAllTimersAsync();
      expect(await promise).toEqual(["Hello", "World"]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(readdirSync(dir)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("throws after exhausting retries when the failure persists", async () => {
    // translateAll degrades to "" on an Azure error. Fine for the map, fatal
    // for the eval, because "" scores null, null pairs get dropped, and the
    // language then reports drift statistics over nothing at all.
    vi.useFakeTimers();
    try {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(azure429()));

      const promise = translateToEnglish(["Bonjour", "Monde"], opts);
      // Attach the rejection handler before advancing timers so the eventual
      // throw is never an unhandled rejection.
      const assertion = expect(promise).rejects.toThrow(/2\/2 documents came back empty/);
      await vi.runAllTimersAsync();
      await assertion;
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps an empty input's empty output, which is not a failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(azureOk(["Hello", ""])));
    expect(await translateToEnglish(["Bonjour", ""], opts)).toEqual(["Hello", ""]);
  });
});

describe("character-rate pacing", () => {
  it("waits before a request that would breach the per-minute budget", async () => {
    // Failure mode: Azure meters ~33K characters/minute on free tier,
    // and a request-count gap does nothing about it. With a tiny budget
    // the second call must be held back until the window drains.
    vi.stubEnv("AZURE_CHARS_PER_MINUTE", "10");
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
        const docs = JSON.parse(String(init?.body)) as { Text: string }[];
        return Promise.resolve(azureOk(docs.map((d) => d.Text)));
      });
      vi.stubGlobal("fetch", fetchMock);

      // Two separate calls of 8 characters each: 8 fits, 8+8 does not.
      await translateTo(["abcdefgh"], "fr", opts); // 8 chars, sent immediately
      const second = translateTo(["12345678"], "de", opts); // must wait for the window

      // Before the window drains, the second request has not gone out.
      await vi.advanceTimersByTimeAsync(1000);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Once ~60s pass the first entry ages out and the second proceeds.
      await vi.advanceTimersByTimeAsync(60000);
      await second;
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("preflightAzure", () => {
  it("surfaces a throttled key before the study spends anything", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(azure429()));
    await expect(preflightAzure()).rejects.toThrow(/HTTP 429/);
  });

  it("resolves against a working resource", async () => {
    const fetchMock = vi.fn().mockResolvedValue(azureOk(["Le renard brun rapide."]));
    vi.stubGlobal("fetch", fetchMock);
    await expect(preflightAzure()).resolves.toBeUndefined();
    // One document, never cached. The point is that it always runs.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(readdirSync(dir)).toEqual([]);
  });
});
