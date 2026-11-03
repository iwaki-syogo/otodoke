/**
 * True only for an absolute https: URL. A stored URL becomes a link only behind this check,
 * so it can neither run script (javascript:) nor open a data blob (data:).
 */
export function isHttpsUrl(raw: string | null | undefined): raw is string {
  if (typeof raw !== "string" || raw === "") return false;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && url.hostname !== "";
  } catch {
    return false;
  }
}
