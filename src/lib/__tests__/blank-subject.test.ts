import { describe, expect, it } from "vitest";
import { isBlankSubject } from "@/lib/mail-notices";

describe("isBlankSubject: when a subject counts as none", () => {
  it("is true for null, empty, white space and characters that draw nothing", () => {
    for (const v of [null, undefined, "", "  ", "　", "​", "​ ﻿‎", "⁠"]) expect(isBlankSubject(v), JSON.stringify(v)).toBe(true);
  });

  it("is false for a subject with any visible character", () => {
    for (const v of ["発送のお知らせ", " a ", "​ご注文​"]) expect(isBlankSubject(v), JSON.stringify(v)).toBe(false);
  });
});
