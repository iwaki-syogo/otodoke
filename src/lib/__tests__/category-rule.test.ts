import { describe, expect, it } from "vitest";
import type { Category } from "@/lib/category";
import { categoryForInsert, categoryForTwins, categoryForUpdate } from "@/lib/match/category";

/**
 * Rules for writing a parcel's category (src/lib/match/category.ts, pure functions):
 *
 * - categoryForInsert(readCategory) -> { category, category_source }
 *     a category from the reading is written as "auto"; none leaves both null.
 * - categoryForUpdate(current, readCategory, bringsFirstItems) -> {} or { category, category_source: "auto" }
 *     never touches a "user" category; writes a non-null value only when the parcel has no
 *     category yet or this reading is the first to bring item names; null never overwrites.
 *     The bulk categorizer uses the same call for parcels whose category is null.
 * - categoryForTwins(keep, absorbed, rebuilt) -> { category, category_source }
 *     after twins merge: a "user" category on the kept parcel wins, then one on an absorbed
 *     parcel; otherwise the category rebuilt from the mails; an "auto" category is not lost
 *     when the rebuilt one is null.
 */

type Cat = { category: Category | null; category_source: "auto" | "user" | null };
const none: Cat = { category: null, category_source: null };
const auto = (category: Category): Cat => ({ category, category_source: "auto" });
const user = (category: Category): Cat => ({ category, category_source: "user" });

/** Apply an update the way the pipeline would. */
const apply = (current: Cat, change: Partial<Cat>): Cat => ({ ...current, ...change });

describe("categoryForInsert", () => {
  it("writes the reading's category as auto", () => {
    expect(categoryForInsert("food")).toEqual(auto("food"));
  });
  it("leaves both empty when the reading has none", () => {
    expect(categoryForInsert(null)).toEqual(none);
  });
});

describe("categoryForUpdate", () => {
  it("never overwrites the user's category", () => {
    expect(categoryForUpdate(user("hobby"), "food", false)).toEqual({});
    expect(categoryForUpdate(user("hobby"), "food", true)).toEqual({});
  });

  it("writes when the parcel has no category yet", () => {
    expect(categoryForUpdate(none, "daily", false)).toEqual(auto("daily"));
  });

  it("never overwrites with null", () => {
    expect(categoryForUpdate(auto("food"), null, false)).toEqual({});
    expect(categoryForUpdate(auto("food"), null, true)).toEqual({});
    expect(categoryForUpdate(none, null, true)).toEqual({});
  });

  it("keeps an existing auto category when this reading brings no new item names", () => {
    expect(categoryForUpdate(auto("food"), "daily", false)).toEqual({});
  });

  it("replaces an auto category when this reading is the first to bring item names", () => {
    expect(categoryForUpdate(auto("other"), "electronics", true)).toEqual(auto("electronics"));
  });

  it("ends with the shop's category when the carrier notice comes first", () => {
    // The carrier notice names no item or shop, so the reading has no category.
    let parcel = categoryForInsert(null);
    // The shop's mail brings the item names and a category.
    parcel = apply(parcel, categoryForUpdate(parcel, "fashion", true));
    expect(parcel).toEqual(auto("fashion"));
  });

  it("keeps the user's choice when a mail arrives after it (auto -> user -> auto)", () => {
    let parcel = categoryForInsert("food");
    parcel = user("beauty"); // the user picks another category
    parcel = apply(parcel, categoryForUpdate(parcel, "electronics", true));
    parcel = apply(parcel, categoryForUpdate(parcel, "daily", false));
    expect(parcel).toEqual(user("beauty"));
  });

  it("fills a parcel with no category for the bulk categorizer", () => {
    expect(categoryForUpdate(none, "hobby", false)).toEqual(auto("hobby"));
  });
});

describe("categoryForTwins", () => {
  it("uses the category rebuilt from the mails when nobody chose one", () => {
    expect(categoryForTwins(none, [none], auto("food"))).toEqual(auto("food"));
  });

  it("does not lose an auto category when the rebuilt one is null", () => {
    expect(categoryForTwins(none, [auto("electronics")], none)).toEqual(auto("electronics"));
    expect(categoryForTwins(auto("daily"), [none], none)).toEqual(auto("daily"));
  });

  it("keeps the absorbed parcel's user category", () => {
    expect(categoryForTwins(auto("food"), [user("hobby")], auto("food"))).toEqual(user("hobby"));
    expect(categoryForTwins(none, [none, user("hobby")], none)).toEqual(user("hobby"));
  });

  it("prefers the kept parcel's user category over the absorbed one's", () => {
    expect(categoryForTwins(user("beauty"), [user("hobby")], auto("food"))).toEqual(user("beauty"));
  });

  it("keeps the kept parcel's user category over the rebuilt one", () => {
    expect(categoryForTwins(user("beauty"), [none], auto("food"))).toEqual(user("beauty"));
  });
});
