import { describe, expect, it, vi } from "vitest";

/**
 * The tab title of each page says what the page is, through the root layout's template
 * ("%s | Otodoke"), and never names a parcel: a product or shop name in the tab would show to
 * anyone who sees the screen shared or the tab bar. Static metadata only, so no page can build its
 * title from the data it reads.
 */

// The pages are only imported here (their metadata), never rendered.
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(), getUser: vi.fn() }));
vi.mock("next/navigation", () => ({ notFound: vi.fn(), redirect: vi.fn(), useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }) }));
// next/font only works inside the Next.js compiler.
vi.mock("@/components/wordmark", () => ({ Wordmark: () => "Otodoke" }));

const template = async () => ((await import("@/app/layout")).metadata.title as { template: string }).template;
const titled = (title: string, t: string) => t.replace("%s", title);

describe("page titles", () => {
  it("the parcel page is 「荷物 | Otodoke」 like the list, with nothing of the parcel in it", async () => {
    const page = await import("@/app/app/parcels/[id]/page");
    expect(page.metadata).toEqual({ title: "荷物" });
    expect(titled(page.metadata.title, await template())).toBe("荷物 | Otodoke");
    // Not built from the parcel: no generateMetadata reads it.
    expect(page).not.toHaveProperty("generateMetadata");
    expect((await import("@/app/app/page")).metadata.title).toBe(page.metadata.title);
  });

  it("the login screens have their own", async () => {
    const titles = [(await import("@/app/login/page")).metadata, (await import("@/app/signup/page")).metadata, (await import("@/app/login/forgot/page")).metadata, (await import("@/app/reset-password/page")).metadata].map((m) => m.title);
    expect(titles).toEqual(["ログイン", "アカウントを作る", "パスワードの再設定", "パスワードの再設定"]);
  });

  it("negative control: the root layout's default is the bare name a page without a title gets", async () => {
    const layout = (await import("@/app/layout")).metadata.title as { default: string };
    expect(layout.default).toBe("Otodoke");
  });
});
