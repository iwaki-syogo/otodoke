const PROBE = "https://otodoke.invalid";

/** Where to go after login: a path on this site. Browsers read "/\\evil.example" as another site, so it is parsed, not pattern-matched. */
export function safeNextPath(value: string | null): string {
  if (!value || !value.startsWith("/")) return "/app";
  try {
    const url = new URL(value, PROBE);
    return url.origin === PROBE ? url.pathname + url.search + url.hash : "/app";
  } catch {
    return "/app";
  }
}
