/**
 * Where a parcel goes back to when the user says it has not arrived, from the row read from the
 * database (never from the client): with a tracking number or a carrier it was shipped, without
 * either it goes back to ordered. Empty text and text of spaces only count as none.
 */
export function undeliveredStatus(row: { tracking_number: string | null; carrier: string | null }): "shipped" | "ordered" {
  const known = (v: string | null | undefined) => (v ?? "").trim().length > 0;
  return known(row.tracking_number) || known(row.carrier) ? "shipped" : "ordered";
}
