import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * [S1] A parcel taken out by 「これは荷物ではありません」 is hidden by a restrictive row-level-security policy on
 * parcels. That policy applies to the person's own session only. A page that read parcels with the
 * service-role client (createAdminClient) would show a taken-out parcel again and count it in the spending.
 * So the pages that show parcels or their money read with createClient (the person's session) and never
 * import the admin client. FakeDb has no row-level security, so this is checked at the source.
 */

const app = path.resolve(__dirname, "../../app/app");
const PAGES = [
  "page.tsx",
  "spend/page.tsx",
  "calendar/page.tsx",
  "cancelled/page.tsx",
  "delivered/page.tsx",
  "parcels/[id]/page.tsx",
  "excluded/page.tsx",
];

const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

/** What is wrong with a page's source, empty when it reads as the person. */
function problems(source: string): string[] {
  const code = stripComments(source);
  const out: string[] = [];
  if (!/import\s*\{[^}]*\bcreateClient\b[^}]*\}\s*from\s*"@\/lib\/supabase\/server"/.test(code)) out.push("does not import createClient from the person's session");
  if (/\bcreateAdminClient\b/.test(code)) out.push("uses createAdminClient");
  if (/lib\/supabase\/admin/.test(code)) out.push("imports the admin client module");
  if (/SERVICE_ROLE/.test(code)) out.push("names the service-role key");
  return out;
}

describe("[S1] the pages that show parcels or spending read as the person, never with the admin client", () => {
  it.each(PAGES)("%s", (page) => {
    expect(problems(readFileSync(path.join(app, page), "utf8")), page).toEqual([]);
  });

  it("negative control: a page using the admin client, or no session client, is caught", () => {
    const real = readFileSync(path.join(app, "spend/page.tsx"), "utf8");
    expect(problems(real)).toEqual([]);
    expect(problems(`${real}\nimport { createAdminClient } from "@/lib/supabase/admin";\nconst db = createAdminClient();`).length).toBeGreaterThanOrEqual(2);
    expect(problems(real.replace(/\bcreateClient\b/g, "makeClient"))).toContain("does not import createClient from the person's session");
    expect(problems(`${real}\nconst k = process.env.SUPABASE_SERVICE_ROLE_KEY;`)).toContain("names the service-role key");
  });

  it("the list of pages is the list that exists (a renamed page cannot drop out unseen)", () => {
    for (const page of PAGES) expect(() => readFileSync(path.join(app, page), "utf8"), page).not.toThrow();
  });
});
