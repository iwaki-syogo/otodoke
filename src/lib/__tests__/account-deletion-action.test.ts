import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACCOUNT_DELETE_CONFIRM, ACCOUNT_DELETE_FAILED, ACCOUNT_DELETED_PATH } from "@/lib/account-deletion";
import { withoutComments } from "./source-scan";

/**
 * 設定「アカウントを削除」's Server Action (review E-2).
 *
 * - Nothing is deleted without the confirmation step's field.
 * - Only the signed-in user's account: the id comes from the session, never from the form.
 * - In order: the session's user, the field, the auth user (with the service role), this
 *   browser's session, the page after it. A failure stops before the session is touched.
 * - A failure shows fixed words; what Supabase said goes to the server log only.
 */

const USER = "00000000-0000-4000-8000-00000000000a";
const OTHER = "00000000-0000-4000-8000-0000000000ff";
// What Supabase Auth says when a row still points at the user (a table without on delete cascade).
const DB_MESSAGE = 'Database error deleting user: update or delete on table "users" violates foreign key constraint "x_user_id_fkey" on table "x"';

type AuthError = { message: string; status?: number; code?: string };

const mocks = vi.hoisted(() => ({
  calls: [] as string[],
  user: null as { id: string; email?: string } | null,
  deleteError: null as AuthError | null,
  lookup: { user: null as { id: string } | null, error: null as AuthError | null },
  signOut: { error: null as AuthError | null, throws: false },
  adminThrows: false,
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn((p: string, type?: string) => mocks.calls.push(`revalidatePath ${p} ${type ?? ""}`.trim())),
  revalidateTag: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  // As in Next.js: redirect throws, so nothing after it runs.
  redirect: vi.fn((p: string, type?: string) => {
    mocks.calls.push(`redirect ${p} ${type ?? ""}`.trim());
    throw new Error(`NEXT_REDIRECT ${p}`);
  }),
  notFound: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => {
        mocks.calls.push("getUser");
        return { data: { user: mocks.user }, error: mocks.user ? null : { message: "Auth session missing!" } };
      },
      signOut: async (options?: { scope?: string }) => {
        mocks.calls.push(`signOut ${options?.scope ?? "global"}`);
        if (mocks.signOut.throws) throw new Error("fetch failed");
        return { error: mocks.signOut.error };
      },
    },
  }),
  getUser: async () => mocks.user,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    if (mocks.adminThrows) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
    return {
      auth: {
        admin: {
          deleteUser: async (id: string, soft?: boolean) => {
            mocks.calls.push(`deleteUser ${id} soft=${String(soft)}`);
            return { data: { user: mocks.deleteError ? null : { id } }, error: mocks.deleteError };
          },
          getUserById: async (id: string) => {
            mocks.calls.push(`getUserById ${id}`);
            return { data: { user: mocks.lookup.user }, error: mocks.lookup.error };
          },
        },
      },
    };
  },
}));

const { deleteAccount } = await import("@/app/app/settings/account-actions");

function form(fields: Record<string, string> = { [ACCOUNT_DELETE_CONFIRM.name]: ACCOUNT_DELETE_CONFIRM.value }): FormData {
  const f = new FormData();
  f.set("expectedUserId", USER);
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

/** The action's answer, or the path it redirected to. */
async function run(fields?: Record<string, string>): Promise<{ state: unknown; redirectedTo: string | null }> {
  try {
    return { state: await deleteAccount(null, form(fields)), redirectedTo: null };
  } catch (err) {
    const m = err instanceof Error ? err.message.match(/^NEXT_REDIRECT (.+)$/) : null;
    if (!m) throw err;
    return { state: undefined, redirectedTo: m[1] };
  }
}

let errorLog: ReturnType<typeof vi.spyOn>;
let warnLog: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  mocks.calls.length = 0;
  mocks.user = { id: USER, email: "qa@example.com" };
  mocks.deleteError = null;
  mocks.lookup = { user: { id: USER }, error: null };
  mocks.signOut = { error: null, throws: false };
  mocks.adminThrows = false;
  errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
  warnLog = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  errorLog.mockRestore();
  warnLog.mockRestore();
});

const deletes = () => mocks.calls.filter((c) => c.startsWith("deleteUser"));

describe("deleteAccount: the confirmation step", () => {
  it("deletes nothing without the confirmation step's field", async () => {
    const withoutTheField: Array<Record<string, string>> = [{}, { [ACCOUNT_DELETE_CONFIRM.name]: "yes" }, { [ACCOUNT_DELETE_CONFIRM.name]: "" }, { other: ACCOUNT_DELETE_CONFIRM.value }];
    for (const fields of withoutTheField) {
      mocks.calls.length = 0;
      const { state, redirectedTo } = await run(fields);
      expect(state).toEqual({ error: ACCOUNT_DELETE_FAILED });
      expect(redirectedTo).toBeNull();
      expect(mocks.calls).toEqual(["getUser"]);
    }
  });

  it("the field the section's form carries is the one the action asks for", () => {
    const section = readFileSync(path.resolve(__dirname, "../../app/app/settings/account-deletion.tsx"), "utf8");
    expect(section).toMatch(/<input type="hidden" name=\{ACCOUNT_DELETE_CONFIRM\.name\} value=\{ACCOUNT_DELETE_CONFIRM\.value\} \/>/);
    expect(ACCOUNT_DELETE_CONFIRM).toEqual({ name: "confirm", value: "delete-account" });
  });
});

describe("deleteAccount: only the signed-in user's account", () => {
  it("deletes the session's user, whatever id the form names", async () => {
    const { redirectedTo } = await run({ [ACCOUNT_DELETE_CONFIRM.name]: ACCOUNT_DELETE_CONFIRM.value, id: OTHER, user_id: OTHER, userId: OTHER });
    expect(redirectedTo).toBe(ACCOUNT_DELETED_PATH);
    expect(deletes()).toEqual([`deleteUser ${USER} soft=false`]);
  });

  it("deletes nothing when nobody is signed in, and goes to the login page", async () => {
    mocks.user = null;
    const { redirectedTo } = await run();
    expect(redirectedTo).toBe("/login");
    expect(deletes()).toEqual([]);
    expect(mocks.calls).toEqual(["getUser", "redirect /login"]);
  });

  it("asks Supabase Auth for the user (getUser checks the token), not the cookie alone", () => {
    const source = withoutComments(readFileSync(path.resolve(__dirname, "../../app/app/settings/account-actions.ts"), "utf8"));
    expect(source).toContain("supabase.auth.getUser()");
    expect(source).not.toMatch(/getSession\(/);
    expect([...source.matchAll(/formData\.get\(([^)]+)\)/g)].map((match) => match[1]).sort()).toEqual(['"expectedUserId"', "ACCOUNT_DELETE_CONFIRM.name"]);
    expect(source).toContain("deleteAuthUser(createAdminClient(), user.id)");
    expect(source).not.toMatch(/deleteAuthUser\([^;]*formData/);
  });
});

describe("deleteAccount: the order", () => {
  it("the user, the auth user for good, this browser's session, then the page after it (replacing this one)", async () => {
    const { redirectedTo } = await run();
    expect(redirectedTo).toBe(ACCOUNT_DELETED_PATH);
    expect(mocks.calls).toEqual(["getUser", `deleteUser ${USER} soft=false`, "signOut local", "revalidatePath / layout", `redirect ${ACCOUNT_DELETED_PATH} replace`]);
  });

  it("a failed delete stops before the session: the person stays signed in and can try again", async () => {
    mocks.deleteError = { message: DB_MESSAGE, status: 500, code: "unexpected_failure" };
    const { state, redirectedTo } = await run();
    expect(state).toEqual({ error: ACCOUNT_DELETE_FAILED });
    expect(redirectedTo).toBeNull();
    expect(mocks.calls).toEqual(["getUser", `deleteUser ${USER} soft=false`, `getUserById ${USER}`]);
  });

  it("a delete whose answer was an error but whose user is gone is told as done", async () => {
    mocks.deleteError = { message: "upstream request timeout", status: 504 };
    mocks.lookup = { user: null, error: { message: "User not found", status: 404, code: "user_not_found" } };
    const { redirectedTo } = await run();
    expect(redirectedTo).toBe(ACCOUNT_DELETED_PATH);
    expect(mocks.calls).toEqual(["getUser", `deleteUser ${USER} soft=false`, `getUserById ${USER}`, "signOut local", "revalidatePath / layout", `redirect ${ACCOUNT_DELETED_PATH} replace`]);
  });

  it("a failed delete whose check fails too is a failure", async () => {
    mocks.deleteError = { message: "fetch failed", status: 0 };
    mocks.lookup = { user: null, error: { message: "fetch failed", status: 0 } };
    expect((await run()).state).toEqual({ error: ACCOUNT_DELETE_FAILED });
    expect(mocks.calls).not.toContain("signOut local");
  });

  it("a sign-out that fails after the deletion still ends on the page after it", async () => {
    mocks.signOut = { error: { message: "Internal Server Error", status: 500 }, throws: false };
    expect((await run()).redirectedTo).toBe(ACCOUNT_DELETED_PATH);
    mocks.calls.length = 0;
    mocks.signOut = { error: null, throws: true };
    expect((await run()).redirectedTo).toBe(ACCOUNT_DELETED_PATH);
    expect(mocks.calls.at(-1)).toBe(`redirect ${ACCOUNT_DELETED_PATH} replace`);
  });

  it("the page after it is outside /app, which needs a session", () => {
    expect(ACCOUNT_DELETED_PATH).toBe("/account-deleted");
    const where: string = ACCOUNT_DELETED_PATH;
    expect(where === "/app" || where.startsWith("/app/")).toBe(false);
  });
});

describe("deleteAccount: a failure shows fixed words", () => {
  it("never what Supabase said; that goes to the server log", async () => {
    mocks.deleteError = { message: DB_MESSAGE, status: 500, code: "unexpected_failure" };
    const { state } = await run();
    expect(state).toEqual({ error: "削除できませんでした。少し時間をおいて、もう一度お試しください。" });
    expect(JSON.stringify(state)).not.toContain("foreign key");
    const logged = errorLog.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
    expect(logged).toContain("foreign key constraint");
    expect(logged).toContain("the user is still there");
    expect(logged).not.toContain("@");
  });

  it("the same words when the service role cannot be used at all", async () => {
    mocks.adminThrows = true;
    expect((await run()).state).toEqual({ error: ACCOUNT_DELETE_FAILED });
    expect(errorLog.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n")).toContain("SUPABASE_SERVICE_ROLE_KEY is not set");
    expect(mocks.calls).toEqual(["getUser"]);
  });
});

describe('account-actions.ts is a "use server" file that exports async functions only', () => {
  const exportLines = (source: string) => withoutComments(source).split("\n").filter((l) => /^\s*export\b/.test(l));
  const allowed = (line: string) => /^export async function \w+/.test(line) || /^export (type \w+|interface \w+)/.test(line);

  it("every export is an async function", () => {
    const source = readFileSync(path.resolve(__dirname, "../../app/app/settings/account-actions.ts"), "utf8");
    expect(source.startsWith('"use server";')).toBe(true);
    const lines = exportLines(source);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.filter((l) => !allowed(l))).toEqual([]);
  });

  it("negative control: a re-exported type or a value is caught", () => {
    expect(exportLines('"use server";\nexport type { DeleteAccountState };\nexport const X = 1;\nexport async function a() {}\n').filter((l) => !allowed(l))).toEqual([
      "export type { DeleteAccountState };",
      "export const X = 1;",
    ]);
  });
});
