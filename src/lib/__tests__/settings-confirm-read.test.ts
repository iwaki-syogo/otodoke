import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readApprovalBadge, readConfirmUrl, readMailSoFar } from "@/app/app/settings/settings-reads";
import { FakeDb } from "./fake-db";
import { findAll, parseHtml } from "./html-tree";

/**
 * Which forwarding confirmation the approval card and the after-check use. Anyone who knows the
 * inbound address can mail a look-alike confirmation without Google's link; it must not hide the
 * real one. Ordering is by created_at (the clock the after-check compares), not sent_at.
 */

const USER = "00000000-0000-4000-8000-00000000000a";
const REAL = "https://mail-settings.google.com/mail/vf-real";
const mocks = vi.hoisted(() => ({ state: { db: null as unknown } }));

vi.mock("next/navigation", () => ({ redirect: vi.fn(), notFound: vi.fn(), useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }), usePathname: () => "/app/settings/forwarding" }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => Object.assign(mocks.state.db as FakeDb, { auth: { getUser: async () => ({ data: { user: { id: USER } }, error: null }) } }),
  getUser: async () => ({ id: USER, email: "qa@example.com" }),
}));
vi.mock("@/lib/inbox", () => ({ ensureInboxAddress: async () => "abcdefghjk", inboxEmail: () => "abcdefghjk@in.example.test" }));

let db: FakeDb;
let n = 0;
beforeEach(() => {
  db = new FakeDb();
  mocks.state.db = db;
  n = 0;
});

const mail = (over: Record<string, unknown>) =>
  db.rows("emails").push({ id: `m${++n}`, user_id: USER, classification: "forwarding_confirmation", processing_status: "processed", body_state: "plain", provider_email_id: `p${n}`, forwarding_confirm_url: null, text_body: null, html_body: null, sent_at: null, created_at: "2026-11-01T00:00:00Z", ...over });
// The db here is the type the reads take.
const sb = () => db as unknown as Parameters<typeof readConfirmUrl>[0];

describe("readConfirmUrl", () => {
  it("a newer look-alike without Google's link does not hide the older real confirmation", async () => {
    mail({ created_at: "2026-11-01T00:00:00Z", forwarding_confirm_url: REAL });
    mail({ created_at: "2026-11-05T00:00:00Z", forwarding_confirm_url: "https://evil.example.com/vf-x", text_body: "no link here" });
    mail({ created_at: "2026-11-06T00:00:00Z" });
    const r = await readConfirmUrl(sb(), "t");
    expect(r).toEqual({ url: REAL, failed: false, at: "2026-11-01T00:00:00Z" });
  });

  it("the newest valid one wins when several are valid, and the link may be in the text body", async () => {
    mail({ created_at: "2026-11-01T00:00:00Z", forwarding_confirm_url: REAL });
    mail({ created_at: "2026-11-03T00:00:00Z", text_body: "open https://mail-settings.google.com/mail/vf-newer now" });
    const r = await readConfirmUrl(sb(), "t");
    expect(r.url).toBe("https://mail-settings.google.com/mail/vf-newer");
    expect(r.at).toBe("2026-11-03T00:00:00Z");
  });

  it("an old confirmation with NULL sent_at does not win over a newer one (ordered by created_at)", async () => {
    mail({ created_at: "2026-11-01T00:00:00Z", sent_at: null, forwarding_confirm_url: "https://mail-settings.google.com/mail/vf-old" });
    mail({ created_at: "2026-11-05T00:00:00Z", sent_at: "2026-11-05T00:00:00Z", forwarding_confirm_url: REAL });
    const r = await readConfirmUrl(sb(), "t");
    expect(r.url).toBe(REAL);
    expect(r.at).toBe("2026-11-05T00:00:00Z");
  });

  it("no valid link anywhere is no card, not a failure", async () => {
    mail({ forwarding_confirm_url: "https://evil.example.com/x" });
    expect(await readConfirmUrl(sb(), "t")).toEqual({ url: null, failed: false, at: null });
  });

  it("the forwarding page shows the real card under a forged newer mail", async () => {
    db.rows("user_keys").push({ user_id: USER, key_id: "a".repeat(32), public_key: "x", wrapped_private_key: "x", wrap_iv: "x", kdf_salt: "x", kdf_iterations: 600000, challenge_hash: "0".repeat(64), created_at: "2026-11-06T00:00:00Z", activated_at: "2026-11-06T00:00:00Z", retired_at: null });
    mail({ created_at: "2026-11-01T00:00:00Z", forwarding_confirm_url: REAL });
    mail({ created_at: "2026-11-06T00:00:00Z" });
    const Page = (await import("@/app/app/settings/forwarding/page")).default;
    const root = parseHtml(renderToStaticMarkup(await Page()));
    expect(findAll(root, (x) => x.tag === "a" && x.attrs.href === REAL)).toHaveLength(1);
  });
});

describe("the arrived-after rule compares against that confirmation's created_at, strictly", () => {
  const T = "2026-11-05T00:00:00Z";

  it("a mail with exactly the confirmation's created_at is not 'after' it (gt, not gte)", async () => {
    mail({ created_at: T, forwarding_confirm_url: REAL });
    mail({ classification: "other", created_at: T });
    expect(await readMailSoFar(sb(), USER, "t")).toBe("approval");
    expect(await readApprovalBadge(sb(), USER, "t")).toEqual({ waiting: true, failed: false });
  });

  it("a mail one second later is after it", async () => {
    mail({ created_at: T, forwarding_confirm_url: REAL });
    mail({ classification: "other", created_at: "2026-11-05T00:00:01Z" });
    expect(await readMailSoFar(sb(), USER, "t")).toBe("received");
    expect(await readApprovalBadge(sb(), USER, "t")).toEqual({ waiting: false, failed: false });
  });

  it("the comparison uses the real confirmation's time, not a forged newer one's", async () => {
    mail({ created_at: T, forwarding_confirm_url: REAL });
    mail({ created_at: "2026-11-07T00:00:00Z" });
    mail({ classification: "other", created_at: "2026-11-06T00:00:00Z" });
    expect(await readMailSoFar(sb(), USER, "t")).toBe("received");
  });
});
