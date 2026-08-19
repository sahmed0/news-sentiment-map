// The --dry-run HTTP layer: replaces `globalThis.fetch` so an end-to-end run
// exercises every real code path (production batching, response parsing, the
// cache, the metrics, the writers) without a single external call.
//
// Any URL this router does not recognise THROWS. That is deliberate: it is the
// mechanism that proves a dry run cannot reach HuggingFace, Azure or the dataset
// host, and it turns a future stray fetch into a loud failure instead of spend.
//
// The numbers it produces are deterministic nonsense derived from a text hash.
// They exist to make output shapes checkable; they say nothing about the model.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { NEWSMTSC_URL } from "../datasets.js";

const FIXTURE_JSONL = fileURLToPath(new URL("./newsmtsc-sample.jsonl", import.meta.url));

const AZURE_HOST = "api.cognitive.microsofttranslator.com";
const HF_HOST = "router.huggingface.co";

// Marks which language a fixture "translation" went through, so the return leg
// can undo it. Real Azure output carries no such marker, obviously.
const MARKER = /^\[([a-z-]+)] /;

// Languages whose fixture round trip is deliberately lossy, so a dry run
// produces non-zero drift and the drift tables have something to show.
const LOSSY = new Set(["ar", "ja"]);

// Deterministic [-1, 1] pseudo-score. FNV-1a over the text.
function pseudoScore(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return Number((((h % 2001) - 1000) / 1000).toFixed(3));
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function translateFixture(url: URL, texts: string[]): Response {
  const to = url.searchParams.get("to") ?? "en";
  const translated = texts.map((text) => {
    if (to !== "en") return `[${to}] ${text}`;
    const match = MARKER.exec(text);
    if (!match) return text;
    const stripped = text.slice(match[0].length);
    // A lossy round trip returns a slightly different string, which hashes to a
    // different score - the fixture stand-in for real translation drift.
    return LOSSY.has(match[1]) ? `${stripped} (translated)` : stripped;
  });
  return jsonResponse(translated.map((text) => ({ translations: [{ text }] })));
}

function scoreFixture(inputs: string[]): Response {
  // Production reads score = sum(positive labels) - sum(negative labels), so the
  // three label scores are built to reproduce the intended pseudo-score exactly.
  const body = inputs.map((text) => {
    const s = pseudoScore(text);
    const positive = Math.max(s, 0) + 0.05;
    const negative = Math.max(-s, 0) + 0.05;
    return [
      { label: "positive", score: positive },
      { label: "neutral", score: Math.max(0, 1 - positive - negative) },
      { label: "negative", score: negative },
    ];
  });
  return jsonResponse(body);
}

function parseInputs(init: RequestInit | undefined): string[] {
  const body = typeof init?.body === "string" ? init.body : "";
  const parsed: unknown = JSON.parse(body);
  if (Array.isArray(parsed)) {
    // Azure: [{ Text }, ...]
    return parsed.map((doc) =>
      typeof doc === "object" && doc !== null && typeof (doc as { Text?: unknown }).Text === "string"
        ? (doc as { Text: string }).Text
        : "",
    );
  }
  // HuggingFace: { inputs: [...] }
  const inputs = (parsed as { inputs?: unknown })?.inputs;
  return Array.isArray(inputs) ? inputs.map((t) => (typeof t === "string" ? t : "")) : [];
}

export function fixtureFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (href === NEWSMTSC_URL) {
    return Promise.resolve(new Response(readFileSync(FIXTURE_JSONL, "utf8"), { status: 200 }));
  }
  const url = new URL(href);
  if (url.host === AZURE_HOST) return Promise.resolve(translateFixture(url, parseInputs(init)));
  if (url.host === HF_HOST) return Promise.resolve(scoreFixture(parseInputs(init)));
  throw new Error(`fixture fetch: refusing to reach ${url.host} during --dry-run`);
}

// Returns a restore function so tests can put the real fetch back.
export function installFixtureFetch(): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = fixtureFetch as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = original;
  };
}
