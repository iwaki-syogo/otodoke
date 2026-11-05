import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The sign-in mail (supabase/templates/magic_link.html, the same text as the dashboard's Magic Link and
 * Confirm signup templates). The Web signs in with the link; the iOS app signs in with the code typed
 * in, so the mail must carry both.
 */

const ROOT = path.resolve(__dirname, "../../..");
const template = () => readFileSync(path.join(ROOT, "supabase/templates/magic_link.html"), "utf8");

describe("the sign-in mail template", () => {
  it("carries the code for the iOS app", () => {
    expect(template()).toContain("{{ .Token }}");
  });

  it("carries the link the Web verifies with token_hash", () => {
    expect(template()).toContain('href="{{ .RedirectTo }}&token_hash={{ .TokenHash }}&type=email"');
  });

  it("is the template of both the magic link and the first sign-up", () => {
    const toml = readFileSync(path.join(ROOT, "supabase/config.toml"), "utf8");
    for (const section of ["auth.email.template.magic_link", "auth.email.template.confirmation"]) {
      const start = toml.indexOf(`[${section}]`);
      expect(start, section).toBeGreaterThanOrEqual(0);
      const next = toml.indexOf("\n[", start + 1);
      const body = toml.slice(start, next === -1 ? undefined : next);
      expect(body, section).toContain('content_path = "./supabase/templates/magic_link.html"');
    }
  });
});
