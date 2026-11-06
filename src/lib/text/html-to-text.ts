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

/*
 * The tag steps below scan forward with indexOf instead of using regexes. The regexes they
 * replace took time growing with the square of the length on unclosed tags (`<` repeated, `<a `
 * with no `>`, a link with no `</a>`), and this runs on up to 512K characters of anyone's mail
 * before any limit (the pre-check in screen.ts). Each step gives exactly what its regex gave
 * (named in its comment): src/lib/__tests__/html-to-text-equivalence.test.ts compares them.
 */

/** Only "A"-"Z" lowered, so every index stays where it was (toLowerCase can change the length). */
function asciiLower(s: string): string {
  return s.replace(/[A-Z]+/g, (m) => m.toLowerCase());
}

/** `\w` of a regex without the u flag. Used for the `\b` after a tag name. */
function isWordChar(c: string | undefined): boolean {
  return c !== undefined && /[A-Za-z0-9_]/.test(c);
}

/** next[i] is the first index at or after i where `hit` holds, or the length when there is none. */
function nextIndexes(length: number, hit: (i: number) => boolean): Int32Array {
  const next = new Int32Array(length + 1);
  next[length] = length;
  for (let i = length - 1; i >= 0; i--) next[i] = hit(i) ? i : next[i + 1];
  return next;
}

/** On many unclosed comments a regex takes quadratic time. */
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

const RAW_TEXT = ["script", "style", "head", "title"];

/**
 * Drops these elements with their content: /<(script|style|head|title)[\s\S]*?<\/\1>/gi.
 * Like the regex, the name is only a prefix (`<header>` ends at `</head>`). Once a name has no
 * closing tag after some point, no later opening of it is searched again.
 */
function stripRawText(s: string): string {
  const lower = asciiLower(s);
  // Per name: the answer to the last search for its closing tag, from where it started (-1: none).
  const found = new Map<string, { from: number; at: number }>();
  const closeOf = (name: string, from: number): number => {
    const last = found.get(name);
    if (last && (last.at < 0 || last.at >= from)) return last.at;
    const at = lower.indexOf(`</${name}>`, from);
    found.set(name, { from, at });
    return at;
  };
  let out = "";
  let at = 0;
  let from = 0;
  for (;;) {
    const open = lower.indexOf("<", from);
    if (open < 0) break;
    const name = RAW_TEXT.find((n) => lower.startsWith(n, open + 1));
    const close = name ? closeOf(name, open + 1 + name.length) : -1;
    if (!name || close < 0) {
      from = open + 1;
      continue;
    }
    out += s.slice(at, open);
    at = from = close + name.length + 3;
  }
  return out + s.slice(at);
}

/** The text of a link: " text (url) ", or only the text when the target says nothing. */
function linkText(href: string, inner: string): string {
  const text = stripTags(inner).trim();
  const url = decodeEntities(href.trim());
  if (!text) return " ";
  if (NOISE_HREF.test(url) || url.startsWith("#")) return ` ${text} `;
  return ` ${text} (${url.length > 300 ? url.slice(0, 300) + "…" : url}) `;
}

interface TagRule {
  /** "<a": the tag name, which must end there (`\b`). */
  open: string;
  /** "href=": the attribute whose quoted value is kept. */
  attr: string;
  /** Whether the value may be empty (`*`) or not (`+`). */
  emptyValue: boolean;
  /** For links: the match goes on to the first closing tag after the opening tag's `>`. */
  close: string | null;
  build: (value: string, inner: string) => string;
}

/** /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi */
const LINK: TagRule = { open: "<a", attr: "href=", emptyValue: false, close: "</a>", build: linkText };
/** /<img\b[^>]*alt=["']([^"']*)["'][^>]*>/gi, replaced by " $1 " */
const IMAGE: TagRule = { open: "<img", attr: "alt=", emptyValue: true, close: null, build: (alt) => ` ${alt} ` };

/**
 * The matches of a rule's regex (above), without backtracking. For one opening the regex tries the
 * last `attr` before the tag's first `>` first, then the earlier ones; the value may run past that
 * `>`. Whether one of them fits does not depend on which opening it is tried from, so when none
 * fits, every other opening before the same `>` fails too and is skipped.
 */
function replaceTags(s: string, rule: TagRule): string {
  const lower = asciiLower(s);
  const n = s.length;
  const nextGt = nextIndexes(n, (i) => s[i] === ">");
  const nextQuote = nextIndexes(n, (i) => s[i] === '"' || s[i] === "'");
  const nextClose = rule.close === null ? null : nextIndexes(n, (i) => lower.startsWith(rule.close!, i));

  /** The match for an opening whose name ends at `start`, with the tag's first `>` at `tagEnd`. */
  const matchAt = (start: number, tagEnd: number): { value: string; inner: string; end: number } | null => {
    const tag = lower.slice(start, tagEnd);
    for (let i = tag.lastIndexOf(rule.attr); i >= 0; i = i === 0 ? -1 : tag.lastIndexOf(rule.attr, i - 1)) {
      const quote = start + i + rule.attr.length;
      if (s[quote] !== '"' && s[quote] !== "'") continue;
      const valueEnd = nextQuote[quote + 1];
      if (valueEnd === n || (!rule.emptyValue && valueEnd === quote + 1)) continue;
      const gt = nextGt[valueEnd + 1];
      if (gt === n) continue;
      if (!nextClose) return { value: s.slice(quote + 1, valueEnd), inner: "", end: gt + 1 };
      const close = nextClose[gt + 1];
      if (close === n) continue;
      return { value: s.slice(quote + 1, valueEnd), inner: s.slice(gt + 1, close), end: close + rule.close!.length };
    }
    return null;
  };

  let out = "";
  let at = 0;
  let from = 0;
  for (;;) {
    const open = lower.indexOf(rule.open, from);
    if (open < 0) break;
    const start = open + rule.open.length;
    if (isWordChar(s[start])) {
      from = open + 1;
      continue;
    }
    const tagEnd = nextGt[start];
    // No ">" after it: no later opening can match either.
    if (tagEnd === n) break;
    const match = matchAt(start, tagEnd);
    if (!match) {
      from = tagEnd + 1;
      continue;
    }
    out += s.slice(at, open) + rule.build(match.value, match.inner);
    at = from = match.end;
  }
  return out + s.slice(at);
}

/** /<(br|hr)\b[^>]*\/?>/gi becomes a newline: a match always ends at the first `>` after the name. */
function replaceLineBreaks(s: string): string {
  const lower = asciiLower(s);
  let out = "";
  let at = 0;
  let from = 0;
  for (;;) {
    const open = lower.indexOf("<", from);
    if (open < 0) break;
    const named = lower.startsWith("br", open + 1) || lower.startsWith("hr", open + 1);
    if (!named || isWordChar(s[open + 3])) {
      from = open + 1;
      continue;
    }
    const gt = s.indexOf(">", open + 3);
    if (gt < 0) break;
    out += s.slice(at, open) + "\n";
    at = from = gt + 1;
  }
  return out + s.slice(at);
}

/** /<[^>]+>/g: from a "<" to the next ">", except "<>" itself. */
function stripTags(s: string): string {
  let out = "";
  let at = 0;
  let from = 0;
  for (;;) {
    const open = s.indexOf("<", from);
    if (open < 0) break;
    const gt = s.indexOf(">", open + 1);
    // No ">" after it: no later "<" can close either.
    if (gt < 0) break;
    if (gt === open + 1) {
      from = gt;
      continue;
    }
    out += s.slice(at, open);
    at = from = gt + 1;
  }
  return out + s.slice(at);
}

export function htmlToText(html: string): string {
  let s = stripInvisible(html);
  s = stripComments(s);
  s = stripRawText(s);
  // Links: keep the visible text and the target when the target is informative.
  s = replaceTags(s, LINK);
  s = replaceTags(s, IMAGE);
  s = replaceLineBreaks(s);
  s = s.replace(/<\/(p|div|tr|li|h[1-6]|table|section|article|blockquote|pre)>/gi, "\n");
  s = s.replace(/<\/(td|th)>/gi, "\t");
  s = stripTags(s);
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
