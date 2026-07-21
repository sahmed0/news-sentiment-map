// Only http(s) URLs from third-party providers may be rendered as links -
// a javascript: or data: URL from a compromised feed must never become an href.
export function safeHttpUrl(url: unknown): string | null {
  if (typeof url !== "string") return null;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? url : null;
  } catch { return null; }
}
