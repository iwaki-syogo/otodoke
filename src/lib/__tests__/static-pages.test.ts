import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The pages that read nothing from the request stay prerendered (○ in `next build`). Next renders
 * the root not-found with every page as its fallback, so a root 404 that reads the request makes
 * them per request (ƒ): the one that read the session did so to /privacy and /account-deleted once
 * the two were merged. src/app/not-found.tsx reads no session now (review R3-6) and its one way
 * back is トップへ (/). Each page keeps `dynamic = "force-static"`, so it stays static if the root
 * 404 ever reads the request again. The build's route list is the proof; this keeps the line from
 * being dropped as if it did nothing.
 */

const STATIC_PAGES = ["src/app/privacy/page.tsx", "src/app/account-deleted/page.tsx"];

describe("pages that read nothing are prerendered", () => {
  it.each(STATIC_PAGES)("%s is force-static", (file) => {
    expect(readFileSync(path.join(process.cwd(), file), "utf8")).toMatch(/^export const dynamic = "force-static";$/m);
  });
});
