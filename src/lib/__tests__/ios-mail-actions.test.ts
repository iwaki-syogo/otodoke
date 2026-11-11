import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 「これは荷物」 and 「読み取る」 finish inside the iOS app (no Safari). The words iOS shows are the Web's, looked up in the
 * Web's own source (dropped/page.tsx, trouble/page.tsx, settings-errors.ts), and the views draw them through
 * SettingsMailText.swift only. A file or sentence that cannot be read is a failure, not a pass.
 */
const ROOT = path.resolve(__dirname, "../../..");
// Cross-repository checks can use an immutable snapshot of the Web's actual files before integration.
const WEB_ROOT = process.env.OTODOKE_CONSENT_WEB_ROOT ?? ROOT;
const read = (p: string) => (existsSync(path.join(ROOT, p)) ? readFileSync(path.join(ROOT, p), "utf8") : "");
const readWebContract = (p: string) => readFileSync(path.join(WEB_ROOT, p), "utf8");
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"])\/\/.*$/gm, "$1");
const stripTsx = (src: string) => src.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

const SETTINGS = "ios/Otodoke/Screens/Settings";
const WORDS = `${SETTINGS}/SettingsMailText.swift`;
const WEB = "src/app/app/settings";

const constant = (src: string, name: string) => src.match(new RegExp(`static let ${name} = "([^"\\\\]*)"`))?.[1];

/** The iOS constant, the Web file and the text the Web writes around it (so a short word is looked for in its own place). */
const WEB_SOURCES: { name: string; file: string; around: [string, string] }[] = [
  { name: "markLabel", file: `${WEB}/dropped/page.tsx`, around: ['<PressButton label="', '" busyLabel='] },
  { name: "markBusy", file: `${WEB}/dropped/page.tsx`, around: ['busyLabel="', '" className='] },
  { name: "marked", file: `${WEB}/dropped/page.tsx`, around: ['<span className="shrink-0 text-xs text-emerald-800">', "</span>"] },
  { name: "rememberedNote", file: `${WEB}/dropped/page.tsx`, around: ["remembered: { ok: true, register: true, text: \"", '" }'] },
  { name: "sharedNote", file: `${WEB}/dropped/page.tsx`, around: ["shared: { ok: true, register: true, text: \"", '" }'] },
  { name: "forwardedNote", file: `${WEB}/dropped/page.tsx`, around: ["forwarded: { ok: true, register: true, text: \"", '" }'] },
  { name: "ownNote", file: `${WEB}/dropped/page.tsx`, around: ["own: { ok: true, register: true, text: \"", '" }'] },
  { name: "markFailed", file: `${WEB}/dropped/page.tsx`, around: ["failed: { ok: false, register: false, text: \"", '" }'] },
  { name: "register", file: `${WEB}/dropped/page.tsx`, around: ["\n                ", "\n              </Link>"] },
  { name: "readLabel", file: `${WEB}/trouble/page.tsx`, around: ['<PressButton label="', '" busyLabel='] },
  { name: "readBusy", file: `${WEB}/trouble/page.tsx`, around: ['busyLabel="', '" className='] },
  { name: "readFailed", file: "src/lib/read-notices.ts", around: ['READ_FAILED_NOTICE = "', '";'] },
  { name: "readUnavailableNotice", file: "src/lib/read-notices.ts", around: ['READ_UNAVAILABLE_NOTICE = "', '";'] },
  { name: "readOverLimitNotice", file: "src/lib/read-notices.ts", around: ['READ_OVER_LIMIT_NOTICE = "', '";'] },
  { name: "readStoppedReason", file: "src/lib/read-notices.ts", around: ['READ_STOPPED_REASON = "', '";'] },
  { name: "readStoppedButton", file: "src/lib/read-notices.ts", around: ['READ_STOPPED_BUTTON = "', '";'] },
  { name: "readOverLimitReason", file: "src/lib/read-notices.ts", around: ['READ_OVER_LIMIT_REASON = "', '";'] },
  { name: "readFailedReason", file: "src/lib/read-notices.ts", around: ['READ_FAILED_REASON = "', '";'] },
  { name: "unknownFailure", file: "src/lib/settings-errors.ts", around: ['UNKNOWN_SETTINGS_ERROR = "', '";'] },
];

describe("「これは荷物」 and 「読み取る」: the words are the Web's", () => {
  const src = stripComments(read(WORDS));

  it("each constant is the Web's sentence in its own place in the Web's source", () => {
    expect(src).not.toBe("");
    for (const w of WEB_SOURCES) {
      const ios = constant(src, w.name);
      expect(ios, `SettingsMailText.${w.name}`).toBeTruthy();
      const web = stripTsx(read(w.file));
      expect(web, w.file).not.toBe("");
      expect(web.includes(w.around[0] + ios! + w.around[1]), `${w.name} in ${w.file}`).toBe(true);
    }
  });

  it("the Web's read_failed code says that same sentence (read-notices.ts is the one place)", () => {
    expect(stripTsx(read("src/lib/settings-errors.ts"))).toContain("read_failed: READ_FAILED_NOTICE,");
  });

  it("every constant of the file is checked (a new sentence needs a Web source)", () => {
    const names = [...src.matchAll(/static let (\w+) = "/g)].map((m) => m[1]).sort();
    expect(names).toEqual(WEB_SOURCES.map((w) => w.name).sort());
  });

  it("negative control: a changed iOS sentence, or one only in a comment, is caught", () => {
    const web = stripTsx(read(`${WEB}/dropped/page.tsx`));
    const changed = constant(src.replace("次から Claude が確認します", "次から確認します"), "rememberedNote")!;
    expect(web.includes("remembered: { ok: true, register: true, text: \"" + changed + '" }')).toBe(false);
    const readFailed = stripTsx(read("src/lib/read-notices.ts"));
    expect(readFailed.includes('READ_FAILED_NOTICE = "' + constant(src.replace("時間をおいて", "しばらくして"), "readFailed")! + '";')).toBe(false);
    // A sentence that stands only in a Web comment is not the Web's.
    expect(stripTsx("// read_failed: \"x\",").includes('read_failed: "x",')).toBe(false);
  });

  it("the notes of the outcomes are the four of the Web's markWronglyDropped, and the page says the same", () => {
    const actions = read(`${WEB}/actions.ts`);
    for (const outcome of ["remembered", "shared", "forwarded", "own"]) {
      expect(actions, outcome).toContain(`"${outcome}"`);
      expect(src, outcome).toContain(`case .${outcome}:`);
    }
    const model = stripComments(read("ios/Otodoke/Data/MailActionsAPI.swift"));
    for (const outcome of ["remembered", "shared", "forwarded", "own"]) expect(model, outcome).toContain(`case ${outcome}`);
  });
});

describe("the views draw them through the constants, and nothing opens the Web", () => {
  const pages = stripComments(read(`${SETTINGS}/SettingsPages.swift`));
  const rows = stripComments(read(`${SETTINGS}/SettingsStatusRows.swift`));
  const buttons = stripComments(read(`${SETTINGS}/MailActionButtons.swift`));
  const model = stripComments(read(`${SETTINGS}/MailActionsModel.swift`));
  const dropped = pages.match(/struct SettingsDroppedPage[\s\S]*?\n\}\n/)?.[0] ?? "";

  it("the dropped page and the unread card use the buttons that work in the app", () => {
    expect(dropped).not.toBe("");
    expect(dropped).toContain("MarkParcelButton(model: model.mailActions");
    expect(dropped).toContain("SettingsMailText.marked");
    expect(dropped).toContain("SettingsMailText.register");
    expect(dropped).not.toMatch(/SettingsWeb\.open\(\./);
    expect(rows).toContain("ReadWaitingButton(model: model.mailActions)");
    expect(rows).not.toMatch(/readWaiting|\.markAsParcel/);
  });

  it("the unread card states only the reasons that apply, through the constants, in the Web's order (stopped, limit, failure)", () => {
    const stopped = rows.indexOf("SettingsMailText.readStoppedReason");
    const over = rows.indexOf("SettingsMailText.readOverLimitReason");
    const failed = rows.indexOf("SettingsMailText.readFailedReason");
    expect(stopped).toBeGreaterThan(-1);
    expect(over).toBeGreaterThan(stopped);
    expect(failed).toBeGreaterThan(over);
    expect(rows).toContain("SettingsMailText.readStoppedButton");
    // Each is drawn only for its own count, and only when the counts were read.
    expect(rows).toMatch(/if case let \.loaded\(reasons\)\? = model\.unreadReasons/);
    for (const n of ["stopped", "overLimit", "failed"]) expect(rows, n).toContain(`reasons.${n} > 0`);
    // The sentence the Web took away ("1 日の上限を超えたか、…") is gone, and no reason sentence is typed into the view.
    expect(rows).not.toContain("1 日の上限を超えたか");
    expect(rows).not.toContain("保存してあるので");
    const web = stripTsx(read("src/lib/read-notices.ts"));
    for (const name of ["READ_STOPPED_REASON", "READ_OVER_LIMIT_REASON", "READ_FAILED_REASON", "READ_STOPPED_BUTTON"]) {
      const text = web.match(new RegExp(`${name} = "([^"]+)"`))?.[1];
      expect(text, name).toBeTruthy();
      expect(rows, name).not.toContain(text!);
      expect(pages, name).not.toContain(text!);
    }
  });

  it("the notice after 「読み取る」 comes from the constants: stopped first, then the limit", () => {
    expect(model).toContain("SettingsMailText.readUnavailableNotice");
    expect(model).toContain("SettingsMailText.readOverLimitNotice");
    expect(model.indexOf("result.stopped")).toBeGreaterThan(-1);
    expect(model.indexOf("result.stopped")).toBeLessThan(model.indexOf("result.overLimit"));
    expect(stripComments(read("ios/Otodoke/Data/MailActionsAPI.swift"))).toContain('answer["stopped"]');
  });

  it("the buttons draw the labels and the busy words from the constants, with a spinner, and are never disabled", () => {
    for (const n of ["markLabel", "markBusy", "readLabel", "readBusy"]) expect(buttons, n).toContain(`SettingsMailText.${n}`);
    expect(buttons).toContain("ProgressView()");
    expect(buttons).not.toMatch(/\.disabled\(/);
  });

  it("no Japanese literal of these words is left in a view", () => {
    for (const s of ["これは荷物", "荷物として記録済み", "記録しています", "読み取っています", "荷物を登録する", "覚えました"]) {
      expect(pages, s).not.toContain(s);
      expect(rows, s).not.toContain(s);
      expect(buttons, s).not.toContain(s);
    }
    expect(rows).not.toContain('"読み取る"');
  });

  it("the Web pages of the two buttons are not linked any more", () => {
    const webLink = stripComments(read("ios/Otodoke/Screens/Shared/OpenWeb.swift"));
    expect(webLink).not.toMatch(/settingsTrouble|settingsDropped|\/app\/settings\/trouble|\/app\/settings\/dropped/);
    const settingsModel = stripComments(read(`${SETTINGS}/SettingsModel.swift`));
    expect(settingsModel).not.toMatch(/case \.readWaiting|case \.markAsParcel/);
  });

  it("one press is one request: a second press while one runs returns before it sends, and nothing is sent again", () => {
    expect(model).toMatch(/guard markingID == nil else \{ return \}/);
    expect(model).toMatch(/guard !isReading else \{ return \}/);
    // The flag is set before the first await (no suspension between the guard and the flag).
    expect(model).toMatch(/guard markingID == nil else \{ return \}\s*markingID = id/);
    const read = model.match(/func readWaiting\(\) async \{[\s\S]*?\n    \}\n/)?.[0] ?? "";
    // The synchronous permission gate may return to the choice, before the busy flag or any await.
    const start = /guard !isReading else \{ return \}\s*guard mayRead\(\) else \{ readNote = nil; requestReadingConsent\(\); return \}\s*isReading = true/;
    expect(read).toMatch(start);
    const token = read.indexOf("await accessToken()");
    const permission = read.indexOf("guard mayRead() else { requestReadingConsent(); return }");
    expect(token).toBeGreaterThan(read.indexOf("isReading = true"));
    expect(permission).toBeGreaterThan(token);
    expect(read.indexOf("api.readWaiting(")).toBeGreaterThan(permission);
    // Both the busy guard and the two permission gates remain necessary after this source update.
    expect(read.replace("guard !isReading else { return }", "")).not.toMatch(start);
    expect(read.replace("guard mayRead() else { readNote = nil; requestReadingConsent(); return }", "")).not.toMatch(start);
    expect(read.replace("guard mayRead() else { requestReadingConsent(); return }", "")).not.toContain("guard mayRead() else { requestReadingConsent(); return }");
    expect(model).not.toMatch(/retry|again\(/i);
  });
});

describe("the calls follow the shape of the sample endpoints (docs/api/demo.md)", () => {
  const client = stripComments(read("ios/Otodoke/Data/MailActionsAPI.swift"));

  it("POST /api/mail/mark-parcel { id } and /api/mail/read-waiting { }, Bearer, JSON, no redirect, read-waiting waits 310 s", () => {
    expect(client).toContain('api/mail/\\(endpoint)');
    expect(client).toContain('post("mark-parcel", ["id": id]');
    expect(client).toContain('post("read-waiting", [:]');
    expect(client).toContain('request.httpMethod = "POST"');
    expect(client).toContain('"Bearer \\(accessToken)"');
    expect(client).toContain("KeyAPIClient.NoRedirect()");
    expect(client).toMatch(/static let readTimeout: TimeInterval = 310/);
    expect(client).toMatch(/case "unauthorized": throw \.unauthorized/);
    expect(client).toMatch(/case "invalid_input": throw \.invalidInput/);
    expect(client).toMatch(/case "not_found": throw \.notFound/);
    expect(client).toMatch(/case "mark_failed": throw \.markFailed/);
    expect(client).toMatch(/case "unavailable": throw \.unavailable/);
    expect(client).toMatch(/case "read_failed": throw \.readFailed/);
    expect(client).toMatch(/case "ai_consent_required": throw \.aiConsentRequired/);
  });

  it("a timeout or a cancel is not a failure (the result is not known): the model says nothing and reads again", () => {
    expect(client).toMatch(/error\.code == \.timedOut \|\| error\.code == \.cancelled \{\s*throw \.unknownResult/);
  });

  it("negative control: another path or a changed timeout is caught", () => {
    expect(client.replace("read-waiting", "read_waiting")).not.toContain('post("read-waiting", [:]');
    expect(client.replace("= 310", "= 60")).not.toMatch(/readTimeout: TimeInterval = 310/);
  });
});

describe("the iOS client follows the Web's contract (docs/api/mail.md, src/app/api/mail/**)", () => {
  const client = stripComments(read("ios/Otodoke/Data/MailActionsAPI.swift"));
  const doc = readWebContract("docs/api/mail.md");
  const handler = readWebContract("src/app/api/mail/handler.ts");
  const codes = (src: string) => [...src.matchAll(/case "(\w+)": throw \./g)].map((m) => m[1]).sort();
  const documentedCodes = (src: string) => [...new Set([...src.matchAll(/^\| \d{3} \| `(\w+)` \|/gm)].map((m) => m[1]))].sort();
  const answeredCodes = (src: string) => {
    const union = src.match(/export type MailApiCode\s*=\s*([^;]+);/)?.[1] ?? "";
    return [...union.matchAll(/"(\w+)"/g)].map((m) => m[1]).sort();
  };

  it("the Web has both routes and the doc names both paths", () => {
    expect(existsSync(path.join(ROOT, "src/app/api/mail/mark-parcel/route.ts"))).toBe(true);
    expect(existsSync(path.join(ROOT, "src/app/api/mail/read-waiting/route.ts"))).toBe(true);
    expect(doc).toContain("POST /api/mail/mark-parcel");
    expect(doc).toContain("POST /api/mail/read-waiting");
  });

  it("keeps the six established mappings and only adds the consent refusal, safely rejected by an older iOS client", () => {
    // A code may be documented for more than one failure source (503 unavailable: auth or consent).
    const web = [...new Set([...doc.matchAll(/^\| \d{3} \| `(\w+)` \|/gm)].map((m) => m[1]))].sort();
    const established = ["invalid_input", "mark_failed", "not_found", "read_failed", "unauthorized", "unavailable"];
    expect(web).toEqual(["ai_consent_required", ...established]);
    const mapped = codes(client);
    if (mapped.includes("ai_consent_required")) {
      expect(mapped).toEqual(web);
      const target = client.match(/case "ai_consent_required": throw \.(\w+)/)?.[1];
      expect(target).toBeTruthy();
      expect(["network", "unknownResult"]).not.toContain(target);
      const failures = client.match(/enum MailAPIFailure:[\s\S]*?\n\}/)?.[0] ?? "";
      expect(failures).toMatch(new RegExp(`\\bcase ${target}\\b`));
    } else {
      expect(mapped).toEqual(established);
      // Forward compatibility of the existing build: a new 403 fails as network; it is neither
      // successful nor an unknown result that would silently hide the permission refusal.
      expect(handler).toMatch(/ai_consent_required: 403/);
      expect(client).toMatch(/if http\.statusCode == 200, KeyAPIClient\.isJSONTrue\(object\["ok"\]\) \{ return object \}/);
      expect(client).toMatch(/default: throw http\.statusCode == 200 \? \.unknownResult : \.network/);
      expect(client.replace("default: throw http.statusCode == 200 ? .unknownResult : .network", "default: throw .unknownResult"))
        .not.toMatch(/default: throw http\.statusCode == 200 \? \.unknownResult : \.network/);
    }
    for (const c of web) expect(handler, c).toContain(c);
  });

  it("the codes iOS maps are exactly the codes the Web answers with", () => {
    // unavailable is documented for both auth and consent lookup failures; it is one response code.
    const web = documentedCodes(doc);
    expect(web).toEqual(["ai_consent_required", "invalid_input", "mark_failed", "not_found", "read_failed", "unauthorized", "unavailable"]);
    expect(answeredCodes(handler)).toEqual(web);
    expect(codes(client)).toEqual(web);
    for (const c of web) expect(handler, c).toContain(c);
    expect(handler).toMatch(/ai_consent_required:\s*403/);
    expect(doc).toMatch(/^\| 403 \| `ai_consent_required` \|/m);
    // No one source can silently omit the new contract while the others have it.
    expect(codes(client.replace('case "ai_consent_required": throw .aiConsentRequired', ""))).not.toEqual(web);
    expect(documentedCodes(doc.replace(/^\| 403 \| `ai_consent_required`[^\n]*\n/gm, ""))).not.toEqual(web);
    expect(answeredCodes(handler.replace(' | "ai_consent_required"', ""))).not.toEqual(web);
  });

  it("the outcomes iOS knows are the Web's four", () => {
    const web = doc.match(/`outcome` is one of:([\s\S]*?)\nThe web shows/)?.[1] ?? "";
    const names = [...web.matchAll(/^- `(\w+)`/gm)].map((m) => m[1]).sort();
    expect(names).toEqual(["forwarded", "own", "remembered", "shared"]);
    for (const n of names) expect(client, n).toContain(`case ${n}`);
  });

  it("the 200 of read-waiting carries read, over_limit, busy and stopped; iOS says only stopped and the limit, never a failure", () => {
    expect(doc).toContain('"read": 3, "over_limit": false, "busy": false, "stopped": false');
    // The handler sends every field in each of its 200s.
    expect(handler.match(/Response\.json\(\{ ok: true, read: done\.read, over_limit: done\.overLimit, busy(?:: [^,]+)?, stopped: (true|false) \}/g)?.length).toBe(3);
    // iOS reads stopped and over_limit (JSON true only); busy is not read, so it can neither become a failure nor a sentence.
    expect(client).toContain('answer["stopped"]');
    expect(client).toContain('answer["over_limit"]');
    expect(client).not.toMatch(/busy/);
    // A body without a boolean `stopped` is an older server: nothing is said (as before).
    expect(client).toMatch(/guard Self\.isJSONBool\(answer\["stopped"\]\) else \{ return ReadWaitingResult\(\) \}/);
  });

  it("the wait is longer than the Web's 300 seconds, and a timeout is not retried", () => {
    expect(doc).toContain("at least\n300 seconds");
    const secs = Number(client.match(/static let readTimeout: TimeInterval = (\d+)/)?.[1]);
    expect(secs).toBeGreaterThan(300);
    expect(doc).toContain("Do not retry automatically");
  });

  it("negative control: a missing code, a shorter wait or an unknown outcome is caught", () => {
    expect(codes(client.replace('case "not_found": throw .notFound', ""))).not.toEqual(codes(client));
    expect(Number(client.replace("= 310", "= 300").match(/readTimeout: TimeInterval = (\d+)/)?.[1])).not.toBeGreaterThan(300);
    expect(client.replace("case forwarded", "case forward")).not.toContain("case forwarded");
  });
});

describe("the other tabs, the reading aloud and the 44 pt button (review fixes)", () => {
  const writer = read("ios/Otodoke/Data/ParcelWriter.swift");
  const model = stripComments(read("ios/Otodoke/Screens/Settings/MailActionsModel.swift"));
  const buttons = stripComments(read("ios/Otodoke/Screens/Settings/MailActionButtons.swift"));
  const client = stripComments(read("ios/Otodoke/Data/MailActionsAPI.swift"));
  const rows = stripComments(read("ios/Otodoke/Screens/Settings/SettingsStatusRows.swift"));

  it("ParcelWriter carries the shared announceOutsideChange, and only ParcelWriter publishes", () => {
    expect(writer).toContain("    @MainActor\n    static func announceOutsideChange(_ changes: DataChanges?) {\n        changes?.publish()\n    }\n");
    expect(writer.indexOf("announceOutsideChange")).toBeGreaterThan(writer.indexOf("// MARK: 「古くなった」 (CX1)"));
    expect(writer.indexOf("announceOutsideChange")).toBeLessThan(writer.indexOf("private func announce<T>"));
    expect(model).not.toContain(".publish(");
  });

  it("reading announces once after the answer, whatever it was; marking announces nothing", () => {
    const read = model.match(/func readWaiting\(\) async \{[\s\S]*?\n    \}\n/)?.[0] ?? "";
    const mark = model.match(/func markAsParcel\(id: String\) async \{[\s\S]*?\n    \}\n/)?.[0] ?? "";
    expect(read).not.toBe("");
    expect(read.match(/announceChange\(\)/g)?.length).toBe(1);
    expect(read.indexOf("announceChange()")).toBeGreaterThan(read.indexOf("api.readWaiting"));
    expect(mark).not.toContain("announceChange");
  });

  it("the notes are read aloud, the read note goes when the settings are left, the button is 44 pt tall", () => {
    expect(model).toContain("AccessibilityNotification.Announcement(");
    expect(rows).toContain("clearReadNote()");
    expect(buttons).toMatch(/MarkParcelButton[\s\S]*\.frame\(minHeight: 44\)/);
  });

  it("a connection that broke after sending, or a 5xx that is not JSON, is a result not known", () => {
    expect(client).toMatch(/mayHaveBeenSent: Set<URLError\.Code>[\s\S]*networkConnectionLost[\s\S]*secureConnectionFailed/);
    expect(client).not.toMatch(/mayHaveBeenSent[^\]]*(notConnectedToInternet|cannotConnectToHost)/);
    expect(client).toMatch(/statusCode >= 500 \? \.unknownResult : \.network/);
  });
});
