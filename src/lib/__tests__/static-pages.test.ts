import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The pages that read nothing from the request stay prerendered (○ in `next build`) next to a root
 * 404 that reads the session (src/app/not-found.tsx: signed in, its way back is the parcel list).
 * Next renders the root not-found with every page as its fallback, so that cookie read made
 * /privacy and /account-deleted per request (ƒ) once the two were merged. Each page now says
 * `dynamic = "force-static"`. The build's route list is the proof; this keeps the line from being
 * dropped as if it did nothing.
 */

const STATIC_PAGES = ["src/app/privacy/page.tsx", "src/app/account-deleted/page.tsx"];

describe("pages that read nothing are prerendered", () => {
  it.each(STATIC_PAGES)("%s is force-static", (file) => {
    expect(readFileSync(path.join(process.cwd(), file), "utf8")).toMatch(/^export const dynamic = "force-static";$/m);
  });
});
