import { describe, expect, it } from "vitest";
import { screenMail } from "@/lib/screen";
import { htmlToText } from "@/lib/text/html-to-text";

/**
 * Review B-1: the tag steps of htmlToText were regexes whose time grew with the square of the
 * length on unclosed tags. The webhook runs it in the pre-check (screenMail) before any limit, on
 * up to 512K characters of HTML that anyone with an inbox address can send: one such mail ran past
 * the webhook's 120 s and Resend sent it again up to 8 times. They are forward scans now.
 *
 * Measured on 5aff2a6 (2026-11-06, a Mac): '<' x 64K took 5 s, one tag with many href= at 512K
 * took 34 s, and unclosed `<img alt="x"` grew about twelvefold per doubling (0.5 s at 4.8K). Each
 * case here is 512K and takes about 0.1 s; the limit leaves room for slower machines.
 */

const LENGTH = 512_000;
const LIMIT_MS = 1000;
const fill = (unit: string) => unit.repeat(Math.ceil(LENGTH / unit.length)).slice(0, LENGTH);

const HOSTILE: Array<[string, string]> = [
  ["'<' repeated", fill("<")],
  ["'<a ' repeated", fill("<a ")],
  ["'<img ' repeated", fill("<img ")],
  ["'<script' repeated", fill("<script")],
  ["unclosed '<a href=\"x\">' repeated", fill('<a href="x">')],
  ["'<br ' repeated", fill("<br ")],
  ["'<style>' repeated", fill("<style>")],
  ["unclosed '<img alt=\"x\"' repeated", fill('<img alt="x"')],
  ["one tag with many href= and no </a>", `<a${fill(' href="x"')}>`],
  ["a link whose text is '<' repeated", `<a href="x">${fill("<")}</a>`],
];

function msFor(run: () => unknown): number {
  const started = performance.now();
  run();
  return performance.now() - started;
}

describe("htmlToText on hostile HTML takes well under a second", () => {
  it.each(HOSTILE)("%s (512K characters)", (_name, html) => {
    expect(html.length).toBeGreaterThanOrEqual(LENGTH);
    expect(msFor(() => htmlToText(html))).toBeLessThan(LIMIT_MS);
  });

  it.each(HOSTILE)("the webhook's pre-check (screenMail) on %s", (_name, html) => {
    expect(msFor(() => screenMail({ subject: "ご注文ありがとうございます", text: null, html }))).toBeLessThan(LIMIT_MS);
  });
});

/**
 * What the regex version (5aff2a6) gave for HTML it handled in its own way, quirks included (a
 * `>` inside another attribute ends the tag; the last `alt=` wins, even inside data-alt). The
 * rewrite was checked against that version on the 458 local mails and 400,000 generated strings
 * with no difference (see the commit); these keep the cases it was written around.
 */
const KEPT: Array<[string, string]> = [
  ["<a data-href=\"https://e.example/a\" href=\"https://e.example/b\">two targets</a>", "two targets (https://e.example/b)"],
  ["<a href=\"https://e.example/c\" data-href=\"https://e.example/d\">href first</a>", "href first (https://e.example/d)"],
  ["<a href=\"\">empty href</a> and <a href=''>empty too</a>", "empty href and empty too"],
  ["<A HREF=\"https://e.example/E\">upper case</A> <IMG ALT='Upper alt'>", "upper case (https://e.example/E) Upper alt"],
  ["<a title=\"a>b\" href=\"https://e.example/f\">a \">\" in another value</a>", "b\" href=\"https://e.example/f\">a \">\" in another value"],
  ["<a href=\"https://e.example/g>h\">a \">\" in the href</a>", "a \">\" in the href (https://e.example/g>h)"],
  ["<a href='https://e.example/i\">mixed quotes</a>", "mixed quotes (https://e.example/i)"],
  ["<a href=\"https://e.example/j\">never closed", "never closed"],
  ["<a href=\"https://e.example/k\"", "<a href=\"https://e.example/k\""],
  ["<a href=https://e.example/l>unquoted</a>", "unquoted"],
  ["<a href = \"https://e.example/m\">spaces around =</a>", "spaces around ="],
  ["<abbr title=\"x\">abbr is not a link</abbr> <a_b href=\"https://e.example/n\">a_b</a_b>", "abbr is not a link a_b"],
  ["<img src=\"x.png\" alt=\"一番目\" data-alt=\"二番目\"> <img alt=\"\"> <img/alt=\"slash\"> <imgx alt=\"not an image\">", "二番目 slash"],
  ["<img alt=\"no end\"", "<img alt=\"no end\""],
  ["line<br/>two<BR>three<hr class=\"x\">four<br2>five<br", "line\ntwo\nthree\nfourfive<br"],
  ["<script>var a = \"<a href='https://e.example/o'>t</a>\";</script>after script", "after script"],
  ["<header>header text</head>tail", "tail"],
  ["<scripts>x</script>y <title>T</TITLE>z <style>unclosed", "y z unclosed"],
  ["İİ<a href=\"https://e.example/p\">after a dotted capital I</a>İ<IMG ALT=\"İ\">", "İİ after a dotted capital I (https://e.example/p) İ İ"],
  ["<> <<> a < b > c <<a href=\"https://e.example/q\">t</a>", "<> a c < t (https://e.example/q)"],
  ["<table><tr><td><a href=\"https://e.example/r\"><b>bold</b> link</a></td><td>2</td></tr></table>", "bold link (https://e.example/r) 2"],
  ["<a href=\"https://e.example/?a=1&amp;b=2\">entities in the href</a>", "entities in the href (https://e.example/?a=1&b=2)"],
  ["<a href=\"https://e.example/unsubscribe\">配信停止</a> <a href=\"#top\">top</a> <a href=\"mailto:a@b.example\">mail</a> <a href=\"https://e.example/x.png?s=1\">image</a>", "配信停止 top mail image"],
  ["<!-- <a href=\"https://e.example/s\">hidden</a> -->visible", "visible"],
  ["<a href=\"https://e.example/t\"><img src=\"x.png\" alt=\"picture only\"></a>", ""],
  ["<a href=\"https://e.example/u\"></a>empty text", "empty text"],
  ["<a\nhref=\"https://e.example/v\"\n>newline in the tag</a\n>", "newline in the tag"],
  ["<p>一行目</p><div>二行目</div><li>三</li><h2>見出し</h2><td>a</td><th>b</th>&nbsp;&yen;100&hellip;", "一行目\n二行目\n三\n見出し\na b ¥100…"],
  ["<a href=\"https://e.example/w\">one</a><a href=\"https://e.example/x\">two</a></a>", "one (https://e.example/w) two (https://e.example/x)"],
];

describe("htmlToText gives what the regex version gave", () => {
  it.each(KEPT)("%j", (html, expected) => {
    expect(htmlToText(html)).toBe(expected);
  });

  it("cuts a target over 300 characters", () => {
    const url = `https://e.example/${"long/".repeat(70)}`;
    expect(htmlToText(`<a href="${url}">long url</a>`)).toBe(`long url (${url.slice(0, 300)}…)`);
  });
});
