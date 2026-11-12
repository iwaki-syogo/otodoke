import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { actionReturnPath } from "@/lib/action-identity";
import * as safeNext from "@/lib/safe-next";
import { findAll, parseHtml } from "./html-tree";

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));
vi.mock("@/lib/auth-session", () => ({
  readCookieSession: async () => ({ state: "signed_in", session: { userId: "current-user", email: "current@example.test", amr: [] } }),
}));

const Page = (await import("@/app/account-changed/page")).default;
type QueryValue = string | string[] | undefined;
const PATH = "/app/settings/delete";
const WITH_OLD_INPUT = `${PATH}?confirm=delete-account&expectedUserId=old-user#old`;
const cases: Array<{ name: string; next: QueryValue; safe: string; recovery: string }> = [
  { name: "two next values", next: [WITH_OLD_INPUT, "/app/settings/demo"], safe: "/app", recovery: "/app" },
  { name: "an empty next array", next: [], safe: "/app", recovery: "/app" },
  { name: "a missing next", next: undefined, safe: "/app", recovery: "/app" },
  { name: "one ordinary string", next: WITH_OLD_INPUT, safe: WITH_OLD_INPUT, recovery: PATH },
];

// Exercise Next's actual runtime shape against the old narrower TypeScript declarations too.
const runtimeString = (value: QueryValue) => value as unknown as string;
async function render(next: QueryValue) {
  const params = next === undefined ? {} : { next };
  const props = { searchParams: Promise.resolve(params) } as unknown as Parameters<typeof Page>[0];
  return renderToStaticMarkup(await Page(props));
}
afterEach(() => vi.restoreAllMocks());

describe("recovery query values are normalized at both helper boundaries", () => {
  it.each(cases)("safeNextPath handles $name without assuming a string", ({ next, safe }) => {
    expect(safeNext.safeNextPath(runtimeString(next))).toBe(safe);
  });

  it.each(cases)("actionReturnPath handles $name before delegating malformed types", ({ next, recovery }) => {
    const delegate = vi.spyOn(safeNext, "safeNextPath");
    expect(actionReturnPath(runtimeString(next))).toBe(recovery);
    if (Array.isArray(next)) expect(delegate).not.toHaveBeenCalled();
  });
});

describe("the real recovery page accepts Next query arrays and emits only safe GET links", () => {
  it.each(cases)("renders $name without a 500 or old action payload", async ({ next, recovery }) => {
    const markup = await render(next);
    const html = parseHtml(markup);
    const anchors = findAll(html, (node) => node.tag === "a");
    expect(anchors.map((node) => node.attrs.href)).toEqual([recovery]);
    expect(markup).toContain("current@example.test");
    expect(markup).toContain("このアカウントで画面を開き直す</a>");
    expect(markup).not.toMatch(/<form|<input|confirm=|expectedUserId|old-user|#old/);
  });
});

describe("the existing external/auth exclusions and string behavior remain intact", () => {
  it.each(["https://outside.example/app", "//outside.example/app", "/auth/confirm?token_hash=old", "/AUTH/continue", "/app/%2e%2e/auth/confirm"])("keeps %s out of the recovery destination", async (next) => {
    expect(safeNext.safeNextPath(next)).toBe("/app");
    expect(actionReturnPath(next)).toBe("/app");
    const markup = await render(next);
    expect(findAll(parseHtml(markup), (node) => node.tag === "a").map((node) => node.attrs.href)).toEqual(["/app"]);
    expect(markup).not.toMatch(/<form|<input|token_hash|outside\.example/);
  });
});
