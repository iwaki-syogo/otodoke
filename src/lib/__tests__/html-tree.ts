/**
 * A tiny reader for the HTML that react-dom/server renders, for tests only (the tests run
 * without a DOM). Builds an element tree so a test can ask about parents, classes and text
 * instead of matching the markup as one string.
 */

export interface HtmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: Array<HtmlNode | string>;
  parent: HtmlNode | null;
}

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);

function decode(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function parseAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of raw.matchAll(/([^\s"'=/>]+)(?:="([^"]*)")?/g)) out[m[1]] = decode(m[2] ?? "");
  return out;
}

/** The rendered markup as a tree under a synthetic root. */
export function parseHtml(html: string): HtmlNode {
  const root: HtmlNode = { tag: "#root", attrs: {}, children: [], parent: null };
  let cur = root;
  const re = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w-]*)([^>]*)>|([^<]+)/g;
  for (const m of html.matchAll(re)) {
    if (m[0].startsWith("<!--")) continue;
    if (m[4] !== undefined) {
      cur.children.push(decode(m[4]));
      continue;
    }
    const [, close, rawTag, rawAttrs] = m;
    const tag = rawTag.toLowerCase();
    if (close) {
      // Close up to the nearest open element of this tag.
      let n: HtmlNode | null = cur;
      while (n && n.tag !== tag) n = n.parent;
      if (n && n.parent) cur = n.parent;
      continue;
    }
    const node: HtmlNode = { tag, attrs: parseAttrs(rawAttrs), children: [], parent: cur };
    cur.children.push(node);
    if (!VOID.has(tag) && !rawAttrs.trim().endsWith("/")) cur = node;
  }
  return root;
}

export function classesOf(n: HtmlNode): string[] {
  return (n.attrs.class ?? "").split(/\s+/).filter(Boolean);
}

export function hasClasses(n: HtmlNode, ...names: string[]): boolean {
  const cls = classesOf(n);
  return names.every((c) => cls.includes(c));
}

export function textOf(n: HtmlNode | string): string {
  return typeof n === "string" ? n : n.children.map(textOf).join("");
}

export function findAll(n: HtmlNode, pred: (x: HtmlNode) => boolean): HtmlNode[] {
  const out: HtmlNode[] = [];
  const walk = (x: HtmlNode) => {
    for (const c of x.children) {
      if (typeof c === "string") continue;
      if (pred(c)) out.push(c);
      walk(c);
    }
  };
  walk(n);
  return out;
}

export function ancestorsOf(n: HtmlNode): HtmlNode[] {
  const out: HtmlNode[] = [];
  for (let p = n.parent; p && p.tag !== "#root"; p = p.parent) out.push(p);
  return out;
}

/** Links (`<a>`) whose href is exactly `href`. */
export function linksTo(root: HtmlNode, href: string): HtmlNode[] {
  return findAll(root, (x) => x.tag === "a" && x.attrs.href === href);
}
