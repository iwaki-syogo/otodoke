import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * [iOS batch 2, M2 merge] After the approved M1 (ScreenRefresher by token, N3) came into M2: the delivered
 * and cancelled pages tell the refresher by token too, and no app screen calls the older id-keyed API
 * (register / shown / hidden / unregister). With a screen by token in the app, the older API was never
 * read (ScreenRefresher.sceneBecameActive), so a page on it would never read again back in front.
 * [N-new3] The older API is gone from ScreenRefresher (its tests were moved to tokens).
 */

const ROOT = path.resolve(__dirname, "../../..");
const APP = path.join(ROOT, "ios/Otodoke");
const walk = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir).flatMap((name) => {
        const p = path.join(dir, name);
        return statSync(p).isDirectory() ? walk(p) : [p];
      })
    : [];
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"])\/\/.*$/gm, "$1");

/** A call of the older API on a ScreenRefresher (a `refresher` variable or property). */
const OLDER_API = /\brefresher\s*\??\.\s*(register|unregister|shown|hidden)\s*\(/;

const appSources = () =>
  walk(APP)
    .filter((f) => f.endsWith(".swift") && path.basename(f) !== "ScreenRefresher.swift")
    .map((f) => ({ file: path.relative(ROOT, f), src: stripComments(readFileSync(f, "utf8")) }));

describe("M2 merge: the delivered and cancelled pages by token", () => {
  it("no app screen calls the older ScreenRefresher API", () => {
    const sources = appSources();
    expect(sources.length).toBeGreaterThan(10);
    const callers = sources.filter((s) => OLDER_API.test(s.src)).map((s) => s.file);
    expect(callers).toEqual([]);
  });

  it("the check catches the older calls (negative control)", () => {
    for (const call of ["refresher.register(id) {", "refresher.shown(id)", "refresher.hidden(id)", "pages.refresher.unregister(.x)", "refresher?.shown(.a)"]) {
      expect(OLDER_API.test(call), call).toBe(true);
    }
    for (const call of ["refresher.appeared(id, in: tab) {", "refresher.disappeared(token)", "refresher.select(tab)", "StubURLProtocol.register(host:"]) {
      expect(OLDER_API.test(call), call).toBe(false);
    }
  });

  it("StatusPage appears by token in the tab that pushed it, and hands the depth to the details", () => {
    const pages = stripComments(readFileSync(path.join(APP, "Screens/StatusPages.swift"), "utf8"));
    expect(pages).toMatch(/\.shownScreen\(id,\s*in:\s*tab/);
    expect(pages).toMatch(/\.environment\(\\\.detailDepth/);
    const list = stripComments(readFileSync(path.join(APP, "Screens/Parcels/ParcelListView.swift"), "utf8"));
    expect(list).toMatch(/StatusPage\(pages\.delivered,\s*\.delivered,\s*pages\.refresher,\s*in:\s*\.parcels/);
    expect(list).toMatch(/StatusPage\(pages\.cancelled,\s*\.cancelled,\s*pages\.refresher,\s*in:\s*\.parcels/);
    const calendar = stripComments(readFileSync(path.join(APP, "Screens/Calendar/CalendarView.swift"), "utf8"));
    expect(calendar).toMatch(/StatusPage\(pages\.delivered,\s*\.delivered,\s*pages\.refresher,\s*in:\s*\.calendar/);
    const groups = stripComments(readFileSync(path.join(APP, "Screens/Delivered/DeliveredView.swift"), "utf8"));
    expect(groups).toMatch(/detail\(parcel\.id\)\s*\.environment\(\\\.detailDepth,\s*detailDepth\)/);
    const tabs = stripComments(readFileSync(path.join(APP, "Screens/MainTabView.swift"), "utf8"));
    expect(tabs).toMatch(/\.shownScreen\(\.detail\(model\.id\),\s*in:\s*tab,\s*depth:\s*depth/);
  });
});

/** A name of the older id-keyed API (declarations, its stored state, its fallback). */
const OLDER_NAMES = /\bfunc\s+(register|unregister|shown|hidden)\s*\(|\b(shownStack|maxShown|refreshes|refreshing)\b/;

describe("N-new3: the older ScreenRefresher API is gone", () => {
  it("ScreenRefresher.swift holds none of its names", () => {
    const src = stripComments(readFileSync(path.join(APP, "Screens/ScreenRefresher.swift"), "utf8"));
    expect(src).toMatch(/func appeared\(/);
    expect(src).toMatch(/func disappeared\(/);
    const found = src.split("\n").filter((line) => OLDER_NAMES.test(line));
    expect(found).toEqual([]);
  });

  it("the check catches the older names (negative control)", () => {
    for (const line of [
      "    func register(_ id: ScreenID, _ refresh: @escaping Refresh) {",
      "    func unregister(_ id: ScreenID) {",
      "    func shown(_ id: ScreenID) {",
      "    func hidden(_ id: ScreenID) {",
      "    private var shownStack: [ScreenID] = []",
      "    private static let maxShown = 16",
      "    private var refreshes: [ScreenID: Refresh] = [:]",
      "    private var refreshing: Set<ScreenID> = []",
      "        guard let id = shownStack.last, let refresh = refreshes[id], !refreshing.contains(id) else { return }",
    ]) {
      expect(OLDER_NAMES.test(line), line).toBe(true);
    }
    for (const line of [
      "    private var refreshingTokens: Set<ScreenToken> = []",
      "    func appeared(_ id: ScreenID, in tab: MainTab, depth: Int? = nil, refresh: @escaping Refresh) -> ScreenToken {",
      "    func disappeared(_ token: ScreenToken) {",
      "        await front.appearance.refresh()",
    ]) {
      expect(OLDER_NAMES.test(line), line).toBe(false);
    }
  });
});

/** A plain `.refreshable` (not `.refreshableToTheEnd`). */
const PLAIN_REFRESHABLE = /\.refreshable\s*(\{|\()/;

describe("N-r3-1: pull to refresh runs its read to the end", () => {
  it("no app screen uses a plain .refreshable (a push cuts its read off)", () => {
    const users = appSources()
      .filter((s) => path.basename(s.file) !== "RefreshToTheEnd.swift")
      .filter((s) => PLAIN_REFRESHABLE.test(s.src))
      .map((s) => s.file);
    expect(users).toEqual([]);
    const toTheEnd = appSources().filter((s) => /\.refreshableToTheEnd\s*\{/.test(s.src)).map((s) => path.basename(s.file));
    expect(toTheEnd).toEqual(
      expect.arrayContaining(["CalendarView.swift", "DeliveredView.swift", "CancelledView.swift", "ParcelListView.swift", "SpendView.swift", "SettingsView.swift", "ParcelDetailView.swift"]),
    );
  });

  it("the check catches a plain .refreshable (negative control)", () => {
    expect(PLAIN_REFRESHABLE.test(".refreshable { await model.load() }")).toBe(true);
    expect(PLAIN_REFRESHABLE.test(".refreshable(action: load)")).toBe(true);
    expect(PLAIN_REFRESHABLE.test(".refreshableToTheEnd { await model.load() }")).toBe(false);
  });

  it("the modifier runs the action in its own task", () => {
    const src = stripComments(readFileSync(path.join(APP, "Screens/Shared/RefreshToTheEnd.swift"), "utf8"));
    expect(src).toMatch(/refreshable\s*\{\s*await Task\s*\{\s*await action\(\)\s*\}\.value\s*\}/);
  });
});
