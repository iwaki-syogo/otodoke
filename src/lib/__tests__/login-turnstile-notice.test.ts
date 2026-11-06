import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { LOGIN_ERROR_MESSAGES, TURNSTILE_UNAVAILABLE_MESSAGE } from "@/lib/login-errors";

/**
 * Review (fix C's note): when Cloudflare's script cannot load and a send came back with
 * captcha_missing, the page said the same thing twice: the red 「確認が終わりませんでした。ページを
 * 読み込み直すか、別のブラウザでお試しください。」 above the form and the widget's amber
 * 「確認を読み込めませんでした。…」 in its place. The page now tells the widget to keep quiet then.
 * (The widget's side is in login-turnstile-widget.test.ts.)
 */

vi.mock("next/link", async () => {
  const { createElement: h } = await import("react");
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const Link = ({ href, children, prefetch, ...rest }: Record<string, unknown>) => h("a", { href: String(href), ...rest }, children as never);
  return { default: Link };
});
// next/font only works inside the Next.js compiler.
vi.mock("@/components/wordmark", () => ({ Wordmark: () => "Otodoke" }));
// The widget as the page renders it: what it was told about its own notice.
vi.mock("@/app/login/turnstile-widget", () => ({
  TurnstileWidget: (props: { hideUnavailableNotice?: boolean }) => createElement("div", { "data-test-widget": props.hideUnavailableNotice ? "quiet" : "notice" }),
}));

async function loginPage(params: Record<string, string>): Promise<string> {
  const Page = (await import("@/app/login/page")).default as unknown as (p: { searchParams: Promise<Record<string, string>> }) => Promise<Parameters<typeof renderToStaticMarkup>[0]>;
  return renderToStaticMarkup(await Page({ searchParams: Promise.resolve(params) }));
}

describe("one notice when the bot check could not finish", () => {
  it("keeps the widget's notice quiet under captcha_missing, which gives the same advice", async () => {
    const html = await loginPage({ error: "captcha_missing" });
    expect(html).toContain(LOGIN_ERROR_MESSAGES.captcha_missing);
    expect(html).toContain('data-test-widget="quiet"');
    // Both say: reload, or try another browser.
    for (const text of [LOGIN_ERROR_MESSAGES.captcha_missing, TURNSTILE_UNAVAILABLE_MESSAGE]) {
      expect(text).toContain("ページを読み込み直すか、別のブラウザでお試しください。");
    }
  });

  it.each([[{}], [{ error: "captcha_refused" }], [{ error: "busy" }], [{ error: "link_invalid" }]])("lets the widget show its notice otherwise (%o)", async (params) => {
    expect(await loginPage(params)).toContain('data-test-widget="notice"');
  });
});
