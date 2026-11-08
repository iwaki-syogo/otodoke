import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { orderRows } from "@/app/app/settings/settings-row";

/**
 * 1.0 (11): the mail group of the settings list moves the rows that need something done to the top, as the Web does
 * (settings-row.tsx orderRows, (list)/page.tsx). The rule has three parts, and each is read from the Web's source and
 * compared with the Swift (SettingsView.swift):
 *   1. which rows can move, and in which order (ACTION_ORDER: password, trouble, forwarding);
 *   2. when each one moves (its `action` in (list)/page.tsx);
 *   3. the order of the rest (the order of mailRows), and that the account group is not ordered.
 * The Web's own orderRows is run here too, so the table below is the Web's answer and not a copy of it.
 */
const ROOT = path.resolve(__dirname, "../../..");
const read = (p: string) => (existsSync(path.join(ROOT, p)) ? readFileSync(path.join(ROOT, p), "utf8") : "");
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"])\/\/.*$/gm, "$1");
const stripTsx = (src: string) => src.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

const WEB_ROW = stripTsx(read("src/app/app/settings/settings-row.tsx"));
const WEB_LIST = stripTsx(read("src/app/app/settings/(list)/page.tsx"));
const SWIFT = stripComments(read("ios/Otodoke/Screens/Settings/SettingsView.swift"));

/** The Web's row id and the iOS page that is the same row. */
const PAGE: Record<string, string> = { forwarding: "forward", password: "key", dropped: "dropped", "mail-handling": "handling", trouble: "delivery", demo: "sample" };

/** The ids of ACTION_ORDER, in order. */
const webActionOrder = (src: string) => [...(src.match(/const ACTION_ORDER = \[([^\]]*)\]/)?.[1] ?? "").matchAll(/"([\w-]+)"/g)].map((m) => m[1]);
/** The ids of mailRows, in the order they are written. */
const webMailIds = (src: string) => [...(src.match(/const mailRows: LinkRow\[\] = \[([\s\S]*?)\n  \];/)?.[1] ?? "").matchAll(/\bid: "([\w-]+)"/g)].map((m) => m[1]);
/** The `action:` expression of each mail row that has one. */
const webActions = (src: string) => {
  const block = src.match(/const mailRows: LinkRow\[\] = \[([\s\S]*?)\n  \];/)?.[1] ?? "";
  const out: Record<string, string> = {};
  for (const row of block.split(/\n    \{\n|\n    \{ /)) {
    const id = row.match(/\bid: "([\w-]+)"/)?.[1];
    const action = row.match(/\baction: ([^,\n]+),/)?.[1];
    if (id && action) out[id] = action.trim();
  }
  return out;
};

/** The pages of a Swift `[.a, .b]` list constant. */
const swiftList = (src: string, name: string) => [...(src.match(new RegExp(`${name}: \\[SettingsPage\\] = \\[([^\\]]*)\\]`))?.[1] ?? "").matchAll(/\.(\w+)/g)].map((m) => m[1]);
const swiftActionPages = (src: string) => src.match(/static func actionPages\(for model: SettingsModel\) -> Set<SettingsPage> \{[\s\S]*?\n    \}\n/)?.[0] ?? "";

describe("the rows that move up are the Web's, in the Web's order", () => {
  it("the Web's rule is read: password, trouble, forwarding move; the rest keep the order of mailRows", () => {
    expect(webActionOrder(WEB_ROW)).toEqual(["password", "trouble", "forwarding"]);
    expect(webMailIds(WEB_LIST)).toEqual(["forwarding", "password", "dropped", "mail-handling", "trouble", "demo"]);
  });

  it("iOS: the same movable rows in the same order (actionOrder) and the same order for the rest (mailOrder)", () => {
    expect(swiftList(SWIFT, "private static let actionOrder")).toEqual(webActionOrder(WEB_ROW).map((id) => PAGE[id]));
    expect(swiftList(SWIFT, "static let mailOrder")).toEqual(webMailIds(WEB_LIST).map((id) => PAGE[id]));
  });

  it("the Web's answer for each condition, from the Web's own orderRows, is the one iOS's rule gives", () => {
    const rows = webMailIds(WEB_LIST).map((id) => ({ id }));
    const run = (...on: string[]) => orderRows(rows.map((r) => ({ ...r, action: on.includes(r.id) }))).map((r) => r.id);
    expect(run()).toEqual(["forwarding", "password", "dropped", "mail-handling", "trouble", "demo"]);
    expect(run("forwarding")).toEqual(["forwarding", "password", "dropped", "mail-handling", "trouble", "demo"]);
    expect(run("trouble")).toEqual(["trouble", "forwarding", "password", "dropped", "mail-handling", "demo"]);
    expect(run("password")).toEqual(["password", "forwarding", "dropped", "mail-handling", "trouble", "demo"]);
    expect(run("forwarding", "trouble", "password")).toEqual(["password", "trouble", "forwarding", "dropped", "mail-handling", "demo"]);
    expect(run("trouble", "forwarding")).toEqual(["trouble", "forwarding", "password", "dropped", "mail-handling", "demo"]);
  });

  it("when each row moves: the Web's `action` of each row, and iOS's condition for it", () => {
    const actions = webActions(WEB_LIST);
    expect(actions).toEqual({
      forwarding: "confirmation.waiting",
      password: "keyBadge !== null && keyBadge !== UNKNOWN",
      trouble: "Boolean(waiting)",
    });
    const pages = swiftActionPages(SWIFT);
    expect(pages).not.toBe("");
    // forwarding: waiting for approval (a confirmation that could not be read is the red 確認できません, not an action)
    expect(pages).toMatch(/if model\.approvalWaiting, !model\.approvalBadgeFailed \{ out\.insert\(\.forward\) \}/);
    // password: no key (a key that could not be read is UNKNOWN: not an action)
    expect(pages).toMatch(/if case \.none\? = model\.keyPanel \{ out\.insert\(\.key\) \}/);
    // trouble: mail waiting to be read (a count that could not be read is UNKNOWN: not an action)
    expect(pages).toMatch(/if case let \.loaded\(n\)\? = model\.unread, n > 0 \{ out\.insert\(\.delivery\) \}/);
    expect(Object.keys(actions).map((id) => PAGE[id]).sort()).toEqual([...pages.matchAll(/out\.insert\(\.(\w+)\)/g)].map((m) => m[1]).sort());
  });

  it("the list draws the mail group through the ordering and the account group is not ordered (the Web's accountRows are not)", () => {
    expect(SWIFT).toContain("group(Self.mailPages(for: model))");
    expect(WEB_LIST).toContain("rows: orderRows(mailRows)");
    expect(WEB_LIST).toContain("rows: accountRows");
    expect(WEB_LIST).not.toContain("orderRows(accountRows)");
    const account = SWIFT.match(/section\(SettingsWebText\.accountGroup\) \{[\s\S]*?\n                    \}\n/)?.[0] ?? "";
    expect(account).not.toBe("");
    expect(account).not.toMatch(/orderedMailPages|mailPages/);
  });

  it("negative control: another order, another condition, a row that cannot move, and an ordered account are all caught", () => {
    expect(swiftList(SWIFT.replace("[.key, .delivery, .forward]", "[.forward, .key, .delivery]"), "private static let actionOrder")).not.toEqual(webActionOrder(WEB_ROW).map((id) => PAGE[id]));
    expect(swiftList(SWIFT.replace("[.forward, .key, .dropped,", "[.key, .forward, .dropped,"), "static let mailOrder")).not.toEqual(webMailIds(WEB_LIST).map((id) => PAGE[id]));
    expect(swiftActionPages(SWIFT.replace("n > 0 {", "n >= 0 {"))).not.toMatch(/n > 0 \{ out\.insert\(\.delivery\) \}/);
    expect(swiftActionPages(SWIFT.replace("!model.approvalBadgeFailed", "true"))).not.toMatch(/!model\.approvalBadgeFailed/);
    expect(webActions(WEB_LIST.replace("action: Boolean(waiting),", "action: false,"))).not.toHaveProperty("trouble", "Boolean(waiting)");
    expect(webActionOrder("const NOTHING = []")).toEqual([]);
    expect(SWIFT.replace("section(SettingsWebText.accountGroup) {", "section(SettingsWebText.accountGroup) { let _ = Self.mailPages(for: model)").match(/section\(SettingsWebText\.accountGroup\) \{[\s\S]*?\n                    \}\n/)?.[0]).toMatch(/mailPages/);
  });
});
