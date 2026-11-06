import path from "node:path";
import { describe, expect, it } from "vitest";
import { KeyActivationSchema, KeyReadSchema, KeyRegistrationSchema, KeyRewrapSchema, SealBatchSchema, SealedMailReadSchema, type KeyRegistration, type KeyRewrap } from "@/lib/mail-keys";
import { appSourceFiles, read, withoutComments } from "./source-scan";

/**
 * The passphrase never leaves the browser.
 *  - No server action ("use server" file) names a passphrase in its code.
 *  - The key-wrap code (which takes the passphrase) is imported only by client modules.
 *  - The server's input schemas have no such field and refuse unknown ones.
 */

const PASSPHRASE = /passphrase|password|合言葉/i;
const KEY_WRAP_IMPORT = /from\s+["'][^"']*crypto\/(key-wrap|tab-key)["']/;

const rel = (f: string) => path.relative(process.cwd(), f);
const isServerActionFile = (source: string) => /^\s*["']use server["']/.test(withoutComments(source));
const isClientFile = (source: string) => /^\s*["']use client["']/.test(withoutComments(source));

function serverActionsNamingPassphrase(files: Array<{ file: string; source: string }>): string[] {
  return files.filter((f) => isServerActionFile(f.source) && PASSPHRASE.test(withoutComments(f.source))).map((f) => rel(f.file));
}

function serverFilesImportingKeyWrap(files: Array<{ file: string; source: string }>): string[] {
  return files.filter((f) => KEY_WRAP_IMPORT.test(f.source) && !isClientFile(f.source)).map((f) => rel(f.file));
}

const sources = () => appSourceFiles().map((file) => ({ file, source: read(file) }));

describe("the passphrase stays in the browser", () => {
  it("finds the server action files it is about", () => {
    const actions = sources().filter((f) => isServerActionFile(f.source)).map((f) => rel(f.file));
    expect(actions).toContain("src/app/app/settings/key-actions.ts");
    expect(actions).toContain("src/app/app/settings/actions.ts");
  });

  it("no server action names a passphrase", () => {
    expect(serverActionsNamingPassphrase(sources())).toEqual([]);
  });

  it("only client modules import the key-wrap code", () => {
    const importers = sources().filter((f) => KEY_WRAP_IMPORT.test(f.source));
    expect(importers.length).toBeGreaterThan(0);
    expect(serverFilesImportingKeyWrap(sources())).toEqual([]);
    // key-wrap itself is plain code; the modules that reach the browser's screens are client ones.
    expect(isClientFile(read(path.join(process.cwd(), "src/lib/crypto/tab-key.ts")))).toBe(true);
  });

  it("negative control: the checks catch a planted server action and a planted server import", () => {
    const planted = [
      { file: path.join(process.cwd(), "src/app/x/planted-actions.ts"), source: '"use server";\nexport async function save(input: { passphrase: string }) { return input; }\n' },
      { file: path.join(process.cwd(), "src/lib/planted-server.ts"), source: 'import { wrapPrivateKey } from "@/lib/crypto/key-wrap";\nexport const w = wrapPrivateKey;\n' },
    ];
    expect(serverActionsNamingPassphrase(planted)).toEqual(["src/app/x/planted-actions.ts"]);
    expect(serverFilesImportingKeyWrap(planted)).toEqual(["src/lib/planted-server.ts"]);
  });

  it("the server's input schemas have no passphrase field and refuse one", () => {
    for (const schema of [KeyRegistrationSchema, KeyRewrapSchema, KeyActivationSchema, KeyReadSchema, SealedMailReadSchema, SealBatchSchema]) {
      expect(Object.keys(schema.shape).filter((k) => PASSPHRASE.test(k))).toEqual([]);
      expect(schema.safeParse({ passphrase: "x" }).success).toBe(false);
    }
    const input: KeyRegistration = { publicKey: "AA==", wrappedPrivateKey: "AA==", wrapIv: "AA==", kdfSalt: "AA==", kdfIterations: 600_000, expectedCurrentKeyId: null };
    expect(KeyRegistrationSchema.safeParse(input).success).toBe(true);
    expect(KeyRegistrationSchema.safeParse({ ...input, passphrase: "x" }).success).toBe(false);
    // The types say the same (checked by `npm run typecheck`).
    // @ts-expect-error a registration has no passphrase
    const typed: KeyRegistration = { ...input, passphrase: "x" };
    // @ts-expect-error a rewrap has no passphrase
    const rewrap: KeyRewrap = { keyId: "0".repeat(32), previousWrappedPrivateKey: "AA==", wrappedPrivateKey: "AA==", wrapIv: "AA==", kdfSalt: "AA==", kdfIterations: 600_000, passphrase: "x" };
    expect(KeyRewrapSchema.safeParse(rewrap).success).toBe(false);
    void typed;
  });
});
