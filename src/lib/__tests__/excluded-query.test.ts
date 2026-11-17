import { describe, expect, it } from "vitest";
import { listPathWithExcluded, listPathWithoutExcluded } from "@/lib/excluded-query";

describe("listPathWithExcluded", () => {
  it("adds excluded=<id> after the values already there", () => {
    expect(listPathWithExcluded(new URLSearchParams("sample=1&demo=busy"), "p1")).toBe("/app?sample=1&demo=busy&excluded=p1");
  });
  it("is plain /app?excluded=<id> with no query, or null", () => {
    expect(listPathWithExcluded(new URLSearchParams(""), "p1")).toBe("/app?excluded=p1");
    expect(listPathWithExcluded(null, "p1")).toBe("/app?excluded=p1");
  });
  it("replaces an excluded already there and encodes the id", () => {
    expect(listPathWithExcluded(new URLSearchParams("excluded=old&demo=busy"), "a b&c")).toBe("/app?demo=busy&excluded=a%20b%26c");
  });
  it("is undone by listPathWithoutExcluded", () => {
    expect(listPathWithoutExcluded(new URLSearchParams(listPathWithExcluded(new URLSearchParams("sample=1"), "p1").split("?")[1]))).toBe("/app?sample=1");
  });
  it("negative control: the old form drops the query", () => {
    expect(`/app?excluded=${"p1"}`).not.toBe(listPathWithExcluded(new URLSearchParams("sample=1"), "p1"));
  });
});
