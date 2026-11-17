/**
 * The list address with only `excluded` taken off: every other value in the query stays (for example ?demo=busy or ?sample=1).
 * Nothing left in the query gives plain /app.
 */
export function listPathWithoutExcluded(current: { toString(): string } | null | undefined): string {
  const rest = new URLSearchParams(current ? current.toString() : "");
  rest.delete("excluded");
  const query = rest.toString();
  return query ? `/app?${query}` : "/app";
}

/**
 * The list address after taking a parcel out: the current query as it is, plus excluded=<id> at the end
 * (an excluded already there is replaced). The pair of listPathWithoutExcluded.
 */
export function listPathWithExcluded(current: { toString(): string } | null | undefined, id: string): string {
  const rest = new URLSearchParams(current ? current.toString() : "");
  rest.delete("excluded");
  const query = rest.toString();
  return `/app?${query ? `${query}&` : ""}excluded=${encodeURIComponent(id)}`;
}
