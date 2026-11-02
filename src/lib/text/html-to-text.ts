/**
 * Convert an HTML email body into readable plain text for the extractor.
 * Keeps link targets as "text (url)" because some shops (Amazon) put item names
 * and tracking numbers only inside links. No external dependencies.
 */

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  yen: "¥",
  hellip: "…",
  copy: "©",
  reg: "®",
  trade: "™",
  mdash: "—",
  ndash: "–",
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    if (body[0] === "#") {
      const code = body[1].toLowerCase() === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    const named = ENTITIES[body.toLowerCase()];
    return named ?? match;
  });
}

const NOISE_HREF = /(unsubscribe|optout|opt-out|privacy|mailto:|\.(png|jpe?g|gif|webp)(\?|$))/i;

/** Direction marks and zero-width characters hide inside Amazon order numbers and subjects. */
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;

export function stripInvisible(text: string): string {
  return text.replace(INVISIBLE, "");
}

/** A loop rather than a regex: on many unclosed comments the regex takes quadratic time. */
function stripComments(html: string): string {
  let out = "";
  let at = 0;
  for (;;) {
    const open = html.indexOf("<!--", at);
    if (open < 0) return out + html.slice(at);
    out += html.slice(at, open);
    const close = html.indexOf("-->", open + 4);
    if (close < 0) return out;
    at = close + 3;
  }
}

export function htmlToText(html: string): string {
  let s = stripInvisible(html);
  s = stripComments(s);
  s = s.replace(/<(script|style|head|title)[\s\S]*?<\/\1>/gi, "");
  // Links: keep the visible text and the target when the target is informative.
  s = s.replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, inner: string) => {
    const text = inner.replace(/<[^>]+>/g, "").trim();
    const url = decodeEntities(href.trim());
    if (!text) return " ";
    if (NOISE_HREF.test(url) || url.startsWith("#")) return ` ${text} `;
    return ` ${text} (${url.length > 300 ? url.slice(0, 300) + "…" : url}) `;
  });
  s = s.replace(/<img\b[^>]*alt=["']([^"']*)["'][^>]*>/gi, " $1 ");
  s = s.replace(/<(br|hr)\b[^>]*\/?>/gi, "\n");
  s = s.replace(/<\/(p|div|tr|li|h[1-6]|table|section|article|blockquote|pre)>/gi, "\n");
  s = s.replace(/<\/(td|th)>/gi, "\t");
  s = s.replace(/<[^>]+>/g, "");
  s = decodeEntities(s);
  s = s.replace(/ /g, " ");
  // Collapse horizontal whitespace per line, then blank-line runs.
  s = s
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return s;
}

const lineKey = (line: string) => line.replace(/\(?https?:\/\/\S+\)?/g, "").replace(/\s+/g, "");

/**
 * The text the model reads: the text part, followed by the lines only the HTML part has.
 * Some facts (a delivery instruction, a subscription schedule) exist only in HTML, so
 * choosing one part would lose them; repeated lines are dropped to keep the prompt small.
 */
export function emailBodyText(text: string | null | undefined, html: string | null | undefined): string {
  const plain = stripInvisible(text ?? "").trim();
  const fromHtml = html ? htmlToText(html) : "";
  if (!plain) return fromHtml;
  if (!fromHtml) return plain;
  const seen = new Set(plain.split("\n").map(lineKey));
  const extra = fromHtml.split("\n").filter((line) => {
    const key = lineKey(line);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return extra.length ? `${plain}\n\n--- HTML 版にだけある行 ---\n${extra.join("\n")}` : plain;
}
