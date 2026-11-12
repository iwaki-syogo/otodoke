import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../../..");
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");
const sources = {
  reader: read("ios/Otodoke/Auth/SessionAccessTokenReader.swift"),
  settings: read("ios/Otodoke/Screens/Settings/SettingsModel.swift"),
  keys: read("ios/Otodoke/Screens/MainScreens+Keys.swift"),
  consent: read("ios/Otodoke/Data/AIReadingConsent.swift"),
  demo: read("ios/Otodoke/Screens/Settings/DemoModel.swift"),
};
type Sources = typeof sources;
const clean = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"])\/\/.*$/gm, "$1");

/** Balance real Swift braces, skipping strings; comments cannot satisfy a production wiring check. */
function region(source: string, marker: string): { start: number; end: number } {
  const at = source.indexOf(marker);
  if (at < 0 || source.indexOf(marker, at + marker.length) >= 0) throw new Error(`missing or ambiguous Swift block: ${marker}`);
  const opening = source.indexOf("{", at + marker.length);
  if (opening < 0) throw new Error(`missing Swift body: ${marker}`);
  let depth = 1, quoted = false;
  for (let index = opening + 1; index < source.length; index += 1) {
    const char = source[index];
    if (quoted && char === "\\") { index += 1; continue; }
    if (char === '"') { quoted = !quoted; continue; }
    if (quoted) continue;
    if (char === "{") depth += 1;
    if (char === "}" && --depth === 0) return { start: opening + 1, end: index };
  }
  throw new Error(`unclosed Swift body: ${marker}`);
}
function body(source: string, marker: string): string {
  const found = region(source, marker);
  return source.slice(found.start, found.end);
}
function changed(input: Sources, key: keyof Sources, marker: string, mutation: (source: string) => string): Sources {
  const found = region(input[key], marker);
  const before = input[key].slice(found.start, found.end), after = mutation(before);
  if (before === after) throw new Error("negative control did not change the actual source");
  return { ...input, [key]: input[key].slice(0, found.start) + after + input[key].slice(found.end) };
}

const owners = [
  ["demo", "static func live(auth:"],
  ["mail", "private func makeMailActions()"],
  ["mail-recovery", "private func makeMailRecovery()"],
  ["delete", "private func makeAccountDeletion()"],
  ["password", "private func makePasswordChange()"],
] as const;
const lazyFactories = [
  ["mailActions", "MailActionsModel", "makeMailActions"],
  ["mailRecovery", "SettingsMailRecoveryModel", "makeMailRecovery"],
  ["accountDeletion", "AccountDeletionModel", "makeAccountDeletion"],
  ["passwordChange", "PasswordChangeModel", "makePasswordChange"],
] as const;

function assertWiring(input: Sources): void {
  const reader = clean(input.reader), settings = clean(input.settings), keys = clean(input.keys);
  const consent = clean(input.consent), demo = clean(input.demo);
  // This is the executable guard, including its returned value, rather than a declaration-name pin.
  expect(body(reader, "func read(for stamp:")).toMatch(/^\s*guard let stamp,\s*await isCurrent\(stamp\),\s*let session = try\? await session\(\),\s*session\.user\.id\.uuidString\.lowercased\(\) == stamp\.userID,\s*await isCurrent\(stamp\) else \{ return nil \}\s*return session\.accessToken\s*$/);
  expect(body(reader, "init(provider:")).toMatch(/^\s*session = \{ try await provider\.auth\.session \}\s*self\.isCurrent = isCurrent\s*$/);
  expect(reader).not.toMatch(/\.stamp\(\)|UnlockStamp|AppFront|scenePhase/);

  const init = body(settings, "    init(");
  expect(init).toMatch(/generation = auth\.session\.stamp\(\)/);
  expect(settings.match(/auth\.session\.stamp\(\)/g)).toHaveLength(1);
  expect(init).toMatch(/let stamp = generation\s*isCurrentMailIdentity =/);
  expect(body(init, "isCurrentMailIdentity =")).toMatch(/^\s*\[weak auth\] in\s*guard let auth, let stamp else \{ return false \}\s*return auth\.session\.isCurrent\(stamp\)\s*&& auth\.provider\.auth\.currentSession\?\.user\.id\.uuidString\.lowercased\(\) == stamp\.userID\s*$/);
  expect(init).toMatch(/tokenReader = SessionAccessTokenReader\(provider: auth\.provider, isCurrent: \{ \[weak auth\] stamp in auth\?\.session\.isCurrent\(stamp\) == true \}\)/);
  for (const [property, type, factory] of lazyFactories) {
    expect(settings).toMatch(new RegExp(`lazy var ${property}: ${type} = ${factory}\\(\\)\\s*$`, "m"));
    expect(settings).toContain(`@MainActor private func ${factory}()`);
  }
  for (const [owner, marker] of owners) {
    const factory = body(settings, marker);
    expect(factory, owner).toMatch(owner === "demo" ? /let tokens = model\.tokenReader, stamp = model\.generation/ : /let tokens = tokenReader\s*let stamp = generation/);
    if (owner === "mail-recovery") {
      expect(body(factory, "accessToken:"), owner).toMatch(/^\s*\[weak self\] in\s*guard let self, self\.isCurrentMailIdentity\(\) else \{ return nil \}\s*let token = await tokens\.read\(for: stamp\)\s*guard self\.isCurrentMailIdentity\(\) else \{ return nil \}\s*return token\s*$/);
      expect(body(factory, "isCurrent:"), owner).toMatch(/^\s*\[weak self, weak auth\] in\s*guard let self, let auth, let stamp else \{ return false \}\s*return !self\.retired && self\.isCurrentMailIdentity\(\) && auth\.session\.isCurrent\(stamp\)\s*$/);
      expect(factory).toContain("beginWrite: { [weak self] in self?.fence.beginWrite() }");
      expect(factory).toContain("endWrite: { [weak self] in self?.fence.endWrite() }");
    } else {
      expect(body(factory, "accessToken:"), owner).toMatch(/^\s*await tokens\.read\(for: stamp\)\s*$/);
    }
    expect(factory, owner).not.toContain("auth.session.stamp()");
  }
  const live = body(settings, "static func live(auth:");
  expect(body(live, "isCurrent:")).toMatch(/guard let auth, let stamp else \{ return false \}; return auth\.session\.isCurrent\(stamp\)/);
  // Completion of a sent deletion has a different nil-SDK rule from strict token acquisition.
  const deletion = body(settings, "private func makeAccountDeletion()");
  expect(body(deletion, "isCurrent:")).toMatch(/guard let auth, let stamp, auth\.session\.isCurrent\(stamp\) else \{ return false \}\s*guard let session = provider\.auth\.currentSession else \{ return true \}\s*return session\.user\.id\.uuidString\.lowercased\(\) == stamp\.userID/);

  const attach = body(keys, "func attachKeys(");
  expect(attach).toMatch(/let generation = auth\.session\.stamp\(\)/);
  expect(attach.indexOf("let generation =")).toBeLessThan(attach.indexOf("let setup = KeySetup("));
  expect(attach).toMatch(/let tokens = SessionAccessTokenReader\(provider: provider, isCurrent: \{ \[weak auth\] stamp in auth\?\.session\.isCurrent\(stamp\) == true \}\)/);
  expect(body(attach, "accessToken:")).toMatch(/^\s*await tokens\.read\(for: generation\)\s*$/);
  // Key recovery keeps its separate, non-persisting password confirmation client.
  expect(attach).toContain("auth.authenticateForKeyRecovery(authSecret: secret, captchaToken: captcha)");

  const client = body(consent, "init(provider:");
  expect(client).toContain("let tokens = SessionAccessTokenReader(provider: provider, isCurrent: isCurrent)");
  expect(client).toMatch(/guard let token = await tokens\.read\(for: stamp\) else \{ return nil \}/);
  expect(client).toContain('"Authorization": "Bearer \\(token)"');
  expect(client).not.toMatch(/provider\.database|provider\.auth\.session/);

  for (const method of ["load", "clear"] as const) {
    const operation = body(demo, method === "load" ? "func load()" : "func clear(confirmed:");
    const refusal = method === "load" ? "return" : "return false";
    expect(operation).toContain(`guard isCurrent(), phase == .idle else { ${refusal} }`);
    expect(operation).toMatch(new RegExp(`let token = await accessToken\\(\\)\\s*guard isCurrent\\(\\) else \\{ ${refusal} \\}\\s*guard let token else`));
    expect(operation).toMatch(new RegExp(`let result = await api\\.${method}\\(accessToken: token\\)\\s*guard isCurrent\\(\\) else \\{ ${refusal} \\}\\s*switch result`));
  }
}

describe("iOS sending tokens stay bound to the model's captured generation", () => {
  it("the real reader guards and every production factory are connected", () => {
    assertWiring(sources);
  });

  it.each(["before", "owner", "after", "returned-token"])("rejects a missing reader condition: %s", (part) => {
    const mutated = changed(sources, "reader", "func read(for stamp:", (source) => {
      if (part === "before") return source.replace("await isCurrent(stamp),", "");
      if (part === "owner") return source.replace("session.user.id.uuidString.lowercased() == stamp.userID", "true");
      if (part === "after") return source.replace("await isCurrent(stamp) else", "true else");
      return source.replace("return session.accessToken", "return nil");
    });
    expect(() => assertWiring(mutated)).toThrow();
  });

  it.each(owners)("rejects a raw SDK getter in the %s factory", (_, marker) => {
    const mutated = changed(sources, "settings", marker, (source) => source.replace("await tokens.read(for: stamp)", "try? await provider.auth.session.accessToken"));
    expect(() => assertWiring(mutated)).toThrow();
  });

  it("rejects rebinding to the latest stamp inside an old factory", () => {
    const mutated = changed(sources, "settings", "private func makePasswordChange()", (source) => source.replace("stamp = generation", "stamp = auth.session.stamp()"));
    expect(() => assertWiring(mutated)).toThrow();
  });

  it("mail recovery keeps its extra identity guards, retirement and captured generation", () => {
    const marker = "private func makeMailRecovery()";
    for (const mutation of [
      (source: string) => source.replace("guard let self, self.isCurrentMailIdentity() else", "guard let self, true else"),
      (source: string) => source.replace("guard self.isCurrentMailIdentity() else { return nil }", ""),
      (source: string) => source.replace("!self.retired && ", ""),
      (source: string) => source.replace("self.isCurrentMailIdentity() && auth.session.isCurrent(stamp)", "auth.session.isCurrent(stamp)"),
      (source: string) => source.replace("stamp = generation", "stamp = auth.session.stamp()"),
    ]) {
      const mutated = changed(sources, "settings", marker, mutation);
      expect(() => assertWiring(mutated)).toThrow();
    }
    const identity = changed(sources, "settings", "    init(", (source) => source.replace("let stamp = generation", "let stamp = auth.session.stamp()"));
    expect(() => assertWiring(identity)).toThrow();
    const bypass = { ...sources, settings: sources.settings.replace("lazy var mailRecovery: SettingsMailRecoveryModel = makeMailRecovery()", "lazy var mailRecovery: SettingsMailRecoveryModel = anotherFactory()") };
    expect(bypass.settings).not.toBe(sources.settings);
    expect(() => assertWiring(bypass)).toThrow();
  });

  it("rejects a raw KeySetup token or a consent request that stops using its captured token", () => {
    const keys = changed(sources, "keys", "func attachKeys(", (source) => source.replace("await tokens.read(for: generation)", "try? await provider.auth.session.accessToken"));
    expect(() => assertWiring(keys)).toThrow();
    const consent = changed(sources, "consent", "init(provider:", (source) => source.replace('"Authorization": "Bearer \\(token)"', '"Authorization": "Bearer otherToken"'));
    expect(() => assertWiring(consent)).toThrow();
  });

  it.each(["load", "clear"])("rejects a %s result that omits the post-API generation check", (method) => {
    const mutated = changed(sources, "demo", method === "load" ? "func load()" : "func clear(confirmed:", (source) => source.replace(
      new RegExp(`(let result = await api\\.${method}\\(accessToken: token\\))\\s*guard isCurrent\\(\\) else \\{ return(?: false)? \\}`), "$1",
    ));
    expect(() => assertWiring(mutated)).toThrow();
  });

  it("keeps deletion's nil-SDK completion cleanup distinct from a missing sending token", () => {
    const mutated = changed(sources, "settings", "private func makeAccountDeletion()", (source) => source.replace("guard let session = provider.auth.currentSession else { return true }", "guard let session = provider.auth.currentSession else { return false }"));
    expect(() => assertWiring(mutated)).toThrow();
  });

  it("rejects a lazy property that bypasses the verified factory method", () => {
    const mutated = { ...sources, settings: sources.settings.replace("lazy var mailActions: MailActionsModel = makeMailActions()", "lazy var mailActions: MailActionsModel = anotherFactory()") };
    expect(mutated.settings).not.toBe(sources.settings);
    expect(() => assertWiring(mutated)).toThrow();
  });
});
