import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { ChangeSecretInputSchema, FinishResetInputSchema, KeyWrapRestoreSchema, MailRequestInputSchema, SignInInputSchema, SignUpInputSchema } from "@/lib/login-input";
import { KeyActivationSchema, KeyRegistrationSchema, KeyRewrapSchema } from "@/lib/mail-keys";
import { appSourceFiles, read, withoutComments } from "./source-scan";

/**
 * The password never reaches the server (password-v1, decision 2). The browser derives the login
 * secret from it and sends only that; the server never has a place to put a password.
 *
 *  - Every input of the login, reset and change Actions and of the iOS key API has no field named
 *    for a secret, nested ones included, and refuses one (the schemas are strict).
 *  - Their login secret fields take 64 lowercase hex characters only: a password as typed is never
 *    one (every password and auth_secret of fixtures/crypto/password-v1.json is tried).
 *  - No "use server" file and no route handler names a secret in its code. (The Supabase calls
 *    that must say `password:` live in src/lib/login-auth.ts, and there only with a login secret.)
 *  - Of the server's entry points and the code that calls Supabase Auth, only login-auth.ts says
 *    `password:`. The browser's password code (src/lib/crypto/password-v1.ts, the screens' flows)
 *    takes the password as typed and is neither, and no entry point imports password-v1.
 *
 * passphrase-stays-in-browser.test.ts keeps its own checks of the key Actions and the key-wrap code.
 */

const SECRET_NAME = /passphrase|password|合言葉/i;

const HEX64 = "0123456789abcdef".repeat(4);
const KEY_ID = "a".repeat(32);
const REWRAP = { keyId: KEY_ID, previousWrappedPrivateKey: "AA==", wrappedPrivateKey: "AA==", wrapIv: "AA==", kdfSalt: "AA==", kdfIterations: 600_000 };

/** Each input with a value it takes. */
const INPUTS: Array<[string, z.ZodType, Record<string, unknown>]> = [
  ["signInWithAuthSecret", SignInInputSchema, { email: "someone@example.com", authSecret: HEX64, captchaToken: null }],
  ["signUpWithAuthSecret", SignUpInputSchema, { email: "someone@example.com", authSecret: HEX64 }],
  ["resendConfirmation / sendResetMail", MailRequestInputSchema, { email: "someone@example.com" }],
  ["finishReset", FinishResetInputSchema, { authSecret: HEX64, keyId: KEY_ID, challenge: "AA==", expectedCurrentKeyId: null }],
  ["changeLoginSecret", ChangeSecretInputSchema, { currentAuthSecret: HEX64, newAuthSecret: HEX64.replace("0", "f"), rewrap: REWRAP }],
  ["POST /api/keys/register", KeyRegistrationSchema, { publicKey: "AA==", wrappedPrivateKey: "AA==", wrapIv: "AA==", kdfSalt: "AA==", kdfIterations: 600_000, expectedCurrentKeyId: null }],
  ["POST /api/keys/activate", KeyActivationSchema, { keyId: KEY_ID, challenge: "AA==", expectedCurrentKeyId: null }],
  ["POST /api/keys/rewrap", KeyRewrapSchema, REWRAP],
  ["POST /api/keys/restore", KeyWrapRestoreSchema, { keyId: KEY_ID, rewrappedPrivateKey: "AQ==", wrappedPrivateKey: "AA==", wrapIv: "AA==", kdfSalt: "AA==", kdfIterations: 600_000 }],
];

/** Every field name of an object schema, with those of the objects inside it. */
function fieldNames(schema: z.ZodType): string[] {
  let inner: z.ZodType = schema;
  while (inner instanceof z.ZodNullable || inner instanceof z.ZodOptional) inner = inner.unwrap() as z.ZodType;
  if (!(inner instanceof z.ZodObject)) return [];
  return Object.entries(inner.shape as Record<string, z.ZodType>).flatMap(([name, field]) => [name, ...fieldNames(field)]);
}

/** Problems of one input: fields named for a secret, and secret fields it takes anyway. */
function problems(schema: z.ZodType, valid: Record<string, unknown>): string[] {
  const out = fieldNames(schema).filter((name) => SECRET_NAME.test(name)).map((name) => `field ${name}`);
  if (!schema.safeParse(valid).success) out.push("refuses its own valid input");
  for (const name of ["password", "passphrase", "合言葉"]) if (schema.safeParse({ ...valid, [name]: "Tr0ub4dor&3" }).success) out.push(`takes ${name}`);
  return out;
}

const vectors = JSON.parse(readFileSync(path.join(process.cwd(), "fixtures/crypto/password-v1.json"), "utf8")) as { cases: Array<{ name: string; password: string; auth_secret: string }> };

describe("the inputs of the Actions and of the key API", () => {
  it.each(INPUTS)("%s: no field named for a secret, nested ones included, and none taken", (_name, schema, valid) => {
    expect(problems(schema, valid)).toEqual([]);
  });

  it("the nested rewrap is checked too", () => {
    expect(fieldNames(ChangeSecretInputSchema)).toEqual(expect.arrayContaining(["rewrap", "previousWrappedPrivateKey", "wrappedPrivateKey"]));
    expect(ChangeSecretInputSchema.safeParse({ ...INPUTS[4][2], rewrap: { ...REWRAP, password: "x" } }).success).toBe(false);
  });

  it("negative control: an input with a password field, or one that drops unknown fields, is caught", () => {
    expect(problems(z.object({ email: z.string(), password: z.string() }), { email: "a", password: "b" })).toEqual(["field password", "takes password", "takes passphrase", "takes 合言葉"]);
    expect(problems(z.object({ email: z.string(), password: z.string() }).strict(), { email: "a", password: "b" })).toEqual(["field password", "takes password"]);
    // Not strict: zod drops the unknown field and the parse succeeds.
    expect(problems(z.object({ authSecret: z.string() }), { authSecret: HEX64 })).toEqual(["takes password", "takes passphrase", "takes 合言葉"]);
    expect(problems(z.object({ rewrap: z.object({ passphrase: z.string() }).strict().nullable() }).strict(), { rewrap: null })).toEqual(["field passphrase"]);
  });
});

describe("a login secret is 64 lowercase hex, never a password", () => {
  const SECRET_FIELDS: Array<[string, z.ZodType, Record<string, unknown>, string]> = [
    ["signIn", SignInInputSchema, INPUTS[0][2], "authSecret"],
    ["signUp", SignUpInputSchema, INPUTS[1][2], "authSecret"],
    ["finishReset", FinishResetInputSchema, INPUTS[3][2], "authSecret"],
    ["changeLoginSecret (current)", ChangeSecretInputSchema, INPUTS[4][2], "currentAuthSecret"],
    ["changeLoginSecret (new)", ChangeSecretInputSchema, INPUTS[4][2], "newAuthSecret"],
  ];

  it("the vectors have both: passwords that are no secret, secrets of 64 hex", () => {
    expect(vectors.cases.length).toBeGreaterThanOrEqual(10);
    for (const c of vectors.cases) {
      expect(c.auth_secret).toMatch(/^[0-9a-f]{64}$/);
      expect(c.password).not.toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it.each(SECRET_FIELDS)("%s takes every auth_secret of the vectors", (_name, schema, valid, field) => {
    for (const c of vectors.cases) expect(schema.safeParse({ ...valid, [field]: c.auth_secret }).success, c.name).toBe(true);
  });

  it.each(SECRET_FIELDS)("%s refuses every password of the vectors, and every near miss", (_name, schema, valid, field) => {
    const refused = [
      ...vectors.cases.map((c) => c.password),
      HEX64.toUpperCase(),
      HEX64.slice(1),
      `${HEX64}0`,
      ` ${HEX64}`,
      `${HEX64}\n`,
      HEX64.replace("a", "g"),
      "",
    ];
    for (const value of refused) expect(schema.safeParse({ ...valid, [field]: value }).success, JSON.stringify(value)).toBe(false);
    for (const value of [null, 1234, { secret: HEX64 }]) expect(schema.safeParse({ ...valid, [field]: value }).success).toBe(false);
  });

  it("negative control: a field that takes any text takes a password", () => {
    const lax = z.object({ authSecret: z.string() }).strict();
    expect(lax.safeParse({ authSecret: vectors.cases[0].password }).success).toBe(true);
  });
});

const rel = (f: string) => path.relative(process.cwd(), f);
const isServerActionFile = (source: string) => /^\s*["']use server["']/.test(withoutComments(source));
const isRouteHandler = (file: string) => /[/\\]app[/\\].*[/\\]route\.ts$/.test(file);
const isProxy = (file: string) => /[/\\]src[/\\](?:proxy|middleware)\.ts$/.test(file);
/** The server's entry points: Server Actions, route handlers and the proxy. */
const isServerEntry = (f: { file: string; source: string }) => isServerActionFile(f.source) || isRouteHandler(f.file) || isProxy(f.file);

/**
 * Code that calls Supabase Auth: a method of an `auth` client or of its `admin` (signInWithPassword,
 * signUp, updateUser, auth.admin.*), or one of Auth's REST paths. The browser has no Supabase client
 * (no-browser-supabase.test.ts), so the browser's modules are not among them: password-v1.ts and the
 * screens' flows take the password as typed (`password: string`) and hand Supabase nothing.
 */
const callsSupabaseAuth = (source: string) =>
  /\bauth\s*\.\s*(?:admin\b|[A-Za-z_$][\w$]*\s*\()|\/auth\/v1\/(?:token|signup|user|admin|otp|recover|verify|resend)\b/.test(withoutComments(source));

/** Server Actions and route handlers that name a secret in their code (comments left out). */
function entryPointsNamingSecrets(files: Array<{ file: string; source: string }>): string[] {
  return files.filter((f) => (isServerActionFile(f.source) || isRouteHandler(f.file)) && SECRET_NAME.test(withoutComments(f.source))).map((f) => rel(f.file));
}

/**
 * Files whose code could hand Supabase a `password:`, and those occurrences that are not a login
 * secret. Looked at: the server's entry points and the code that calls Supabase Auth. A browser
 * module that takes the typed password is neither, and no entry point may import password-v1 (below).
 */
function passwordFields(files: Array<{ file: string; source: string }>): { files: string[]; notASecret: string[] } {
  const found = files.filter((f) => (isServerEntry(f) || callsSupabaseAuth(f.source)) && /\bpassword\s*:/.test(withoutComments(f.source)));
  const notASecret = found.flatMap((f) =>
    [...withoutComments(f.source).matchAll(/\bpassword\s*:\s*([\w.]+)/g)].filter((m) => !/(^|\.)(authSecret|currentAuthSecret|newAuthSecret)$/.test(m[1])).map((m) => `${rel(f.file)}: password: ${m[1]}`),
  );
  return { files: found.map((f) => rel(f.file)), notASecret };
}

/** An import of password-v1 (static, dynamic, a re-export or a bare one), by any path to it. */
const PASSWORD_V1_IMPORT = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*["'][^"']*\bcrypto\/password-v1(?:\.[jt]sx?)?["']/;

/**
 * The server's entry points that import password-v1 themselves. Its functions take the password as
 * typed, so an entry point with them could take one; passwordFields leaves that file out for this.
 * passphrase-stays-in-browser.test.ts checks the static imports of every module that is not a client one.
 */
function entryPointsImportingPasswordV1(files: Array<{ file: string; source: string }>): string[] {
  return files.filter((f) => isServerEntry(f) && PASSWORD_V1_IMPORT.test(withoutComments(f.source))).map((f) => rel(f.file));
}

const sources = () => appSourceFiles().map((file) => ({ file, source: read(file) }));
const at = (p: string) => path.join(process.cwd(), p);

describe("the server's entry points", () => {
  it("finds the files it is about", () => {
    const entries = sources()
      .filter((f) => isServerActionFile(f.source) || isRouteHandler(f.file))
      .map((f) => rel(f.file));
    for (const file of [
      "src/app/login/actions.ts",
      "src/app/reset-password/actions.ts",
      "src/app/app/settings/password-actions.ts",
      "src/app/app/settings/key-actions.ts",
      "src/app/auth/confirm/route.ts",
      "src/app/api/keys/register/route.ts",
      "src/app/api/keys/restore/route.ts",
    ]) {
      expect(entries).toContain(file);
    }
  });

  it("no Server Action and no route handler names a secret in its code", () => {
    expect(entryPointsNamingSecrets(sources())).toEqual([]);
  });

  it("only src/lib/login-auth.ts hands Supabase a password, and only a login secret", () => {
    expect(passwordFields(sources())).toEqual({ files: ["src/lib/login-auth.ts"], notASecret: [] });
  });

  it("looks at the code that calls Supabase Auth, and not at the browser's password code", () => {
    const all = sources();
    expect(all.filter((f) => callsSupabaseAuth(f.source)).map((f) => rel(f.file))).toEqual(expect.arrayContaining(["src/lib/login-auth.ts", "src/lib/auth-session.ts", "src/proxy.ts"]));
    const v1 = all.find((f) => rel(f.file) === "src/lib/crypto/password-v1.ts");
    expect(v1).toBeDefined();
    expect(isServerEntry(v1!) || callsSupabaseAuth(v1!.source)).toBe(false);
  });

  it("no entry point imports password-v1, whose functions take the typed password", () => {
    expect(entryPointsImportingPasswordV1(sources())).toEqual([]);
  });

  it("negative control: an entry point that imports password-v1, however it is written, is caught; a client module is not", () => {
    const planted = [
      { file: at("src/app/x/planted-actions.ts"), source: '"use server";\nimport { deriveMaster } from "@/lib/crypto/password-v1";\nexport async function go() { return typeof deriveMaster; }\n' },
      { file: at("src/app/api/x/route.ts"), source: 'export async function POST() { const { authSecretHex } = await import("@/lib/crypto/password-v1"); return Response.json(typeof authSecretHex); }\n' },
      { file: at("src/app/api/y/route.ts"), source: 'export { deriveMaster as POST } from "../../../lib/crypto/password-v1.ts";\n' },
      { file: at("src/proxy.ts"), source: 'import "@/lib/crypto/password-v1";\nexport function proxy() {}\n' },
      // Not caught: a client module, and a mention in a comment.
      { file: at("src/app/x/form.tsx"), source: '"use client";\nimport { deriveMaster } from "@/lib/crypto/password-v1";\nexport const d = deriveMaster;\n' },
      { file: at("src/app/x/other-actions.ts"), source: '"use server";\n// not from "@/lib/crypto/password-v1": the browser makes the login secret\nexport async function go() { return 1; }\n' },
    ];
    expect(entryPointsImportingPasswordV1(planted)).toEqual(["src/app/x/planted-actions.ts", "src/app/api/x/route.ts", "src/app/api/y/route.ts", "src/proxy.ts"]);
  });

  it("positive control: a browser module that takes the typed password and hands it to no Supabase call is not looked at", () => {
    const planted = [
      // Like src/lib/crypto/password-v1.ts: plain code that runs in the browser.
      { file: at("src/lib/crypto/planted-derive.ts"), source: 'export async function derive(email: string, password: string) { return crypto.subtle.digest("SHA-256", new TextEncoder().encode(email + password)); }\n' },
      // Like the screens' flows: "use client", the password in its input, a Server Action called with the login secret only.
      {
        file: at("src/lib/crypto/planted-flows.ts"),
        source:
          '"use client";\nimport { signInWithAuthSecret } from "@/app/login/actions";\nexport async function signIn(input: { email: string; password: string }, secretOf: (p: string) => Promise<string>) {\n  return signInWithAuthSecret({ email: input.email, authSecret: await secretOf(input.password), captchaToken: null });\n}\n',
      },
    ];
    expect(passwordFields(planted)).toEqual({ files: [], notASecret: [] });
  });

  it("negative control: server code that calls Supabase Auth with a password is caught, however it reaches Auth", () => {
    const planted = [
      { file: at("src/lib/planted-change.ts"), source: "export const change = (supabase, typed) => supabase.auth.updateUser({ password: typed.password });\n" },
      { file: at("src/lib/planted-admin.ts"), source: "export const set = (db, id, typed) => db.auth.admin.updateUserById(id, { password: typed.password });\n" },
      { file: at("src/lib/planted-destructured.ts"), source: "export async function f(supabase, typed) { const { auth } = supabase; return auth.signUp({ email: typed.email, password: typed.password }); }\n" },
      {
        file: at("src/lib/planted-rest.ts"),
        source: 'export const f = (url, typed) => fetch(`${url}/auth/v1/token?grant_type=password`, { method: "POST", body: JSON.stringify({ email: typed.email, password: typed.password }) });\n',
      },
      { file: at("src/proxy.ts"), source: "export function proxy(request) { return { password: request.headers.get('x') }; }\n" },
    ];
    expect(passwordFields(planted)).toEqual({
      files: ["src/lib/planted-change.ts", "src/lib/planted-admin.ts", "src/lib/planted-destructured.ts", "src/lib/planted-rest.ts", "src/proxy.ts"],
      notASecret: [
        "src/lib/planted-change.ts: password: typed.password",
        "src/lib/planted-admin.ts: password: typed.password",
        "src/lib/planted-destructured.ts: password: typed.password",
        "src/lib/planted-rest.ts: password: typed.password",
        "src/proxy.ts: password: request.headers.get",
      ],
    });
  });

  it("negative control: a planted Action, route or Supabase call with a password is caught", () => {
    const planted = [
      { file: at("src/app/x/planted-actions.ts"), source: '"use server";\nexport async function signIn(input: { email: string; password: string }) { return input; }\n' },
      { file: at("src/app/x/form-actions.ts"), source: '"use server";\nexport async function go(form: FormData) { return form.get("password"); }\n' },
      { file: at("src/app/api/x/route.ts"), source: "export async function POST(request: Request) { const body = await request.json(); return Response.json(body.password); }\n" },
      { file: at("src/app/api/y/route.ts"), source: "// a password is mentioned in a comment only\nexport async function POST() { return new Response(); }\n" },
      { file: at("src/lib/planted-auth.ts"), source: "export const f = (s, typed) => s.auth.signInWithPassword({ email: 'x', password: typed.password });\n" },
    ];
    expect(entryPointsNamingSecrets(planted)).toEqual(["src/app/x/planted-actions.ts", "src/app/x/form-actions.ts", "src/app/api/x/route.ts"]);
    // A `password:` in a type counts too: the planted Action's input type names one.
    expect(passwordFields(planted)).toEqual({
      files: ["src/app/x/planted-actions.ts", "src/lib/planted-auth.ts"],
      notASecret: ["src/app/x/planted-actions.ts: password: string", "src/lib/planted-auth.ts: password: typed.password"],
    });
  });

  it("each step parses its input with its schema before anything else", () => {
    const auth = withoutComments(read(path.join(process.cwd(), "src/lib/login-auth.ts")));
    for (const [step, schema] of [
      ["signIn", "SignInInputSchema"],
      ["signUp", "SignUpInputSchema"],
      ["resendSignupMail", "MailRequestInputSchema"],
      ["requestResetMail", "MailRequestInputSchema"],
      ["finishReset", "FinishResetInputSchema"],
      ["changeSecret", "ChangeSecretInputSchema"],
    ]) {
      const body = auth.slice(auth.indexOf(`export async function ${step}(`));
      const firstLine = body.split("\n").slice(1).find((line) => line.trim() !== "");
      expect(firstLine, step).toContain(`${schema}.safeParse(input)`);
    }
  });
});
