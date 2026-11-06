import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { emailBodyText, htmlToText } from "@/lib/text/html-to-text";

/**
 * Review R2-2: 4fbbfde rewrote the tag steps of htmlToText as forward scans (the regexes took time
 * growing with the square of the length on unclosed tags) and said each gives exactly what its
 * regex gave. This keeps that check in the repository. The regex version (f73de89) is copied
 * below, and both run on the committed demo mails, on hand-made odd HTML, and on HTML generated
 * from fixed seeds (no real mail). The negative control changes one rule of the copy at a time:
 * each change must show a difference on the same inputs, so they can see the rules they compare.
 */

// ---- f73de89:src/lib/text/html-to-text.ts, the regex version. Its five tag regexes are in
// REGEX_RULES so a control can change one; nothing else differs from the file. Characters other
// than ASCII are written as \u escapes.

interface RegexRules {
  rawText: RegExp;
  link: RegExp;
  image: RegExp;
  lineBreak: RegExp;
  tag: RegExp;
}

const REGEX_RULES: RegexRules = {
  rawText: /<(script|style|head|title)[\s\S]*?<\/\1>/gi,
  link: /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
  image: /<img\b[^>]*alt=["']([^"']*)["'][^>]*>/gi,
  lineBreak: /<(br|hr)\b[^>]*\/?>/gi,
  tag: /<[^>]+>/g,
};

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

function decodeEntities(input: string): string {
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

const INVISIBLE = /[​-‏‪-‮⁠-⁤﻿]/g;

function stripInvisible(text: string): string {
  return text.replace(INVISIBLE, "");
}

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

function regexHtmlToText(html: string, rules: RegexRules = REGEX_RULES): string {
  let s = stripInvisible(html);
  s = stripComments(s);
  s = s.replace(rules.rawText, "");
  // Links: keep the visible text and the target when the target is informative.
  s = s.replace(rules.link, (_m, href: string, inner: string) => {
    const text = inner.replace(/<[^>]+>/g, "").trim();
    const url = decodeEntities(href.trim());
    if (!text) return " ";
    if (NOISE_HREF.test(url) || url.startsWith("#")) return ` ${text} `;
    return ` ${text} (${url.length > 300 ? url.slice(0, 300) + "…" : url}) `;
  });
  s = s.replace(rules.image, " $1 ");
  s = s.replace(rules.lineBreak, "\n");
  s = s.replace(/<\/(p|div|tr|li|h[1-6]|table|section|article|blockquote|pre)>/gi, "\n");
  s = s.replace(/<\/(td|th)>/gi, "\t");
  s = s.replace(rules.tag, "");
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

function regexEmailBodyText(text: string | null | undefined, html: string | null | undefined): string {
  const plain = stripInvisible(text ?? "").trim();
  const fromHtml = html ? regexHtmlToText(html) : "";
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

// ---- end of the copy

/** The demo mails committed in fixtures/demo (made-up or anonymized, not the real ones). */
const DEMO_DIR = path.resolve(__dirname, "../../../fixtures/demo/mails");
const DEMO = readdirSync(DEMO_DIR)
  .filter((f) => f.endsWith(".json"))
  .map((f) => ({ file: f, ...(JSON.parse(readFileSync(path.join(DEMO_DIR, f), "utf8")) as { text: string | null; html: string | null }) }));

/** HTML written to hit the corners of the rules: case, quotes, ">" in values, unclosed tags, comments. */
const HAND: string[] = [
  "<A HrEf='https://e.example/a'>Mixed</a> <ScRiPt>x</sCrIpT>after",
  "<STYLE>p{}</style>keep<TITLE>t</Title>keep2<HEAD><b>h</b></HeAd>tail",
  "<IMG SRC=x ALT=\"upper\"/> <Img Alt='mixed'> <iMG aLT=\"\">",
  "a</P>b</Td>c</TH>d</DIV>e</LI>f</H6>g</TABLE>h",
  "<img alt=\"a>b\">x <img title=\"x>y\" alt=\"z\"> <img alt='q\">r'>",
  "<a href=\"https://e.example/1\" title=\">\">t1</a> <a title='>' href='https://e.example/2'>t2</a>",
  "<a data-href=\"https://e.example/a\" href=\"https://e.example/b\">two targets</a>",
  "<a href=\"https://e.example/c\" data-href=\"https://e.example/d\">href first</a>",
  "<a href=\"\">empty href</a> and <a href=''>empty too</a>",
  "<a href=\"\" href=\"https://e.example/h\">empty then full</a>",
  "<a href='https://e.example/i\">mixed quotes</a>",
  "<a href=\"it's\">quote inside</a>",
  "<!-- <script> -->text</script>after",
  "<!--<a href=\"https://e.example/c\">-->y</a>z",
  "<!-- <!-- inner --> still -->out",
  "before<!-- never closed <a href=\"https://e.example/d\">t</a>",
  "<!---->x<!--->y-->z<!-- -- -->w",
  "<a href=\"https://e.example/e\"",
  "<a href=\"https://e.example/f\">text without close",
  "<a href='https://e.example/g>quote never closes</a>",
  "<a <a <a href=\"https://e.example/i\">deep</a>",
  "<a\thref=\"https://e.example/j\">tab</a> <a/href=\"https://e.example/k\">slash</a> <a-x href=\"https://e.example/l\">dash</a>",
  "<a href=\"https://e.example/m\">t</A > <a href=\"https://e.example/n\">u</a\n>",
  "<a href=\"https://e.example/o\"><a href=\"https://e.example/p\">nested</a></a>",
  "<abbr title=\"x\">abbr</abbr> <a_b href=\"https://e.example/q\">a_b</a_b>",
  "<![CDATA[<a href=\"https://e.example/r\">cdata link</a>]]>after",
  "a<br/>b<br />c<br>d<BR>e<br\t>f<br\n>g<brx>h<br-x>i<br_x>j<br1>k<hr/>l<br/ >m</br>n<br",
  "a<br/b<hr",
  "x<BR/><Hr Class='z'/><bR\r\n/>y",
  "<header>header text</head>tail <scripts>x</script>y <title>T</TITLE>z <style>unclosed",
  "&lt;a href=&quot;https://e.example/s&quot;&gt;spelled&lt;/a&gt; &#60;br&#62; &#x3C;b&#x3E;",
  "&amp;lt;br&amp;gt; &nbsp;&yen;&hellip;&#x1F4E6;&#1114112;&#99999999999;&unknown;",
  "<scrİpt>dotted I</script> <ſcript>long s</script> <ımg alt=\"dotless\"> <Ka> İ<A HREF=\"https://e.example/t\">İ</A>",
  "<a href=\"https://e.example/📦\">📦 emoji</a> <a​ href=\"https://e.example/u\">zw</a> <img alt=\"﻿bom\">",
  "line1\r\n<br>\r\nline2\u0000<\u0000a href=\"x\">nul</a> < > <> >< <<>> <a>",
  "<a href=\"https://e.example/unsubscribe\">配信停止</a> <a href=\"#top\">top</a> <a href=\"mailto:a@b.example\">mail</a> <a href=\"https://e.example/x.png?s=1\">image</a>",
  `<a href="https://e.example/${"long/".repeat(70)}">long url</a>`,
  "<table><tr><td><a href=\"https://e.example/v\"><b>bold</b> link</a></td><td>2</td></tr></table>",
  "",
  "<",
  ">",
  "<a",
  "<a href=",
  "<a href=\"",
  "<a href=\"x\"",
  "<a href=\"x\">",
  "<a href=\"x\"></a",
  "<img",
  "<img alt=",
  "<img alt=''",
  "<script",
  "<script>",
  "</script><script></script>",
];

/** mulberry32: a seeded generator, so a difference found can be replayed. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TOKENS = [
  "<a", "<A", "<a ", "<A\t", "<a/", "<ab", "<a_", "<a-", "href=", "HREF=", "hReF=", "data-href=", "alt=", "ALT=", "data-alt=",
  '"', "'", ">", "<", "</a>", "</A>", "</a >", "</a", "<img", "<IMG", "<imgx", "<img/", "<br", "<BR", "<br/", "<br/>", "<hr",
  "<brx", "<br-", "<br_", "<br1", "<script", "<SCRIPT", "</script>", "</SCRIPT>", "<style", "</style>", "<head", "<header",
  "</head>", "<title", "</title>", "<!--", "-->", "--", "<![CDATA[", "]]>", "</p>", "</P>", "</td>", "</th>", "</div>", "</li>",
  "&amp;", "&lt;", "&gt;", "&#60;", "&#x3e;", "&nbsp;", "&", ";", "#", "x", "y", "1", " ", "\t", "\n", "\r\n", "=", "/", "_",
  "-", "İ", "ı", "ſ", "K", "ﬀ", "📦", "​", "﻿", " ", "注文",
  "https://e.example/", "unsubscribe", "#top", "mailto:", ".png",
];

/** Strings of random tokens: unclosed tags, stray quotes and brackets in every order. */
function tokens(next: () => number, maxTokens: number): string {
  const n = 1 + Math.floor(next() * maxTokens);
  let s = "";
  for (let i = 0; i < n; i++) s += TOKENS[Math.floor(next() * TOKENS.length)];
  return s;
}

/** Tags built from parts, so two href= in one tag, empty values and values with ">" are common. */
function builtTags(next: () => number): string {
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)];
  const names = ["a", "A", "img", "IMG", "br", "BR", "hr", "br-", "a_", "script", "style", "head", "title", "p", "td"];
  const attrs = [
    ' href="https://e.example/1"',
    " href='https://e.example/2'",
    ' href=""',
    " href=''",
    ' data-href="https://e.example/3"',
    ' HREF="https://e.example/4"',
    ' alt="pic"',
    ' alt=""',
    " ALT='Pic'",
    ' data-alt="d"',
    ' title="a>b"',
    " title='x\"y'",
    ' href="https://e.example/g>h"',
    " x",
    "/",
    ' href="it\'s"',
    "\n",
    ' alt="a>b"',
  ];
  const inner = ["text", "", "<b>bold</b>", "<", ">", "<>", "注文", "<br>", '<img alt="in">', '<a href="https://e.example/n">nested</a>'];
  const closes = ["</a>", "</A>", "", "</a >", "</script>", "</style>", "</head>", "</title>", "</p>", "</td>"];
  let s = "";
  const parts = 1 + Math.floor(next() * 6);
  for (let p = 0; p < parts; p++) {
    s += "<" + pick(names);
    const n = Math.floor(next() * 4);
    for (let i = 0; i < n; i++) s += pick(attrs);
    if (next() < 0.85) s += next() < 0.2 ? "/>" : ">";
    s += pick(inner);
    s += pick(closes);
    if (next() < 0.3) s += pick([" ", "\n", "x", "&amp;", "&lt;br&gt;", "<!-- c -->", "<!--", "<>"]);
  }
  return s;
}

function generated(count: number, seed: number, make: (next: () => number) => string): string[] {
  const next = seeded(seed);
  return Array.from({ length: count }, () => make(next));
}

const TOKEN_HTML = generated(15_000, 20261106, (next) => tokens(next, 40));
const LONG_TOKEN_HTML = generated(400, 7, (next) => tokens(next, 400));
const BUILT_HTML = [...generated(15_000, 42, builtTags), ...generated(15_000, 20261106, builtTags)];
const ALL_HTML = [...HAND, ...TOKEN_HTML, ...LONG_TOKEN_HTML, ...BUILT_HTML];

/** The inputs on which htmlToText and the given version of the regexes differ, up to `limit`. */
function differences(inputs: readonly string[], rules: RegexRules, limit: number): string[] {
  const found: string[] = [];
  for (const html of inputs) {
    if (htmlToText(html) !== regexHtmlToText(html, rules)) found.push(html);
    if (found.length >= limit) break;
  }
  return found;
}

describe("htmlToText gives what the regex version (f73de89) gave", () => {
  it.each(DEMO.map((m) => [m.file, m] as const))("demo mail %s: htmlToText and emailBodyText", (_file, mail) => {
    if (mail.html !== null) expect(htmlToText(mail.html)).toBe(regexHtmlToText(mail.html));
    expect(emailBodyText(mail.text, mail.html)).toBe(regexEmailBodyText(mail.text, mail.html));
  });

  it.each(HAND.map((h) => [JSON.stringify(h).slice(0, 60), h] as const))("hand-made %s", (_name, html) => {
    expect(htmlToText(html)).toBe(regexHtmlToText(html));
  });

  it(`${TOKEN_HTML.length + LONG_TOKEN_HTML.length} strings of random tokens (seeds 20261106 and 7)`, () => {
    expect(differences([...TOKEN_HTML, ...LONG_TOKEN_HTML], REGEX_RULES, 5)).toEqual([]);
  });

  it(`${BUILT_HTML.length} strings of built tags (seeds 42 and 20261106)`, () => {
    expect(differences(BUILT_HTML, REGEX_RULES, 5)).toEqual([]);
  });

  it("emailBodyText with a text part as well (seed 99)", () => {
    const next = seeded(99);
    const found: string[] = [];
    for (let i = 0; i < 3_000 && found.length < 5; i++) {
      const html = next() < 0.5 ? tokens(next, 30) : builtTags(next);
      const text = next() < 0.6 ? tokens(next, 10) : null;
      if (emailBodyText(text, html) !== regexEmailBodyText(text, html)) found.push(JSON.stringify([text, html]));
    }
    expect(found).toEqual([]);
  });
});

/**
 * Each control is the regex version with one rule changed, as a rewrite could get it wrong. On
 * the same inputs it must differ from htmlToText; if one did not, the inputs above could not see
 * that rule, and their "no difference" would say nothing about it.
 */
const ONE_RULE_CHANGED: Array<[string, Partial<RegexRules>]> = [
  ["href= tried first to last (a lazy [^>]*?)", { link: /<a\b[^>]*?href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi }],
  ["an empty href allowed", { link: /<a\b[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi }],
  ["an empty alt not allowed", { image: /<img\b[^>]*alt=["']([^"']+)["'][^>]*>/gi }],
  ["no \\b after <img", { image: /<img[^>]*alt=["']([^"']*)["'][^>]*>/gi }],
  ["no \\b after <br and <hr", { lineBreak: /<(br|hr)[^>]*\/?>/gi }],
  ["a raw-text element closed by any of the four names", { rawText: /<(script|style|head|title)[\s\S]*?<\/(script|style|head|title)>/gi }],
  ['"<>" counted as a tag', { tag: /<[^>]*>/g }],
  ["tag names matched in lower case only", { link: /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/g }],
];

describe("negative control: one rule changed in the regex version shows a difference", () => {
  it.each(ONE_RULE_CHANGED)("%s", (_name, change) => {
    expect(differences(ALL_HTML, { ...REGEX_RULES, ...change }, 1)).toHaveLength(1);
  });
});
