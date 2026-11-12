import { describe, expect, it } from "vitest";
import { CANNOT_UNDO_NOTE, PARTLY_RESTORED_NOTICE, UNDO_CHANGED_NOTICE, UNDO_FAILED_NOTICE } from "@/lib/format";

describe("Web receipt copy preserves the legacy text contract", () => {
  it("preserves the existing shared partial and cannot-undo exports byte for byte", () => {
    expect(PARTLY_RESTORED_NOTICE).toBe("受け取り済みのままの荷物があります");
    expect(CANNOT_UNDO_NOTE).toBe("元に戻せない荷物があります");
  });

  it("gives an elsewhere-changed receipt its own Web text without asserting its received state", () => {
    expect(UNDO_CHANGED_NOTICE).toBe("ほかで変更された荷物があります");
    expect(UNDO_CHANGED_NOTICE).not.toBe(PARTLY_RESTORED_NOTICE);
    expect(UNDO_CHANGED_NOTICE).not.toContain("受け取り済み");
  });

  it("a failed request makes no assertion about the parcel's received state", () => {
    expect(UNDO_FAILED_NOTICE).toBe("元に戻せませんでした");
    expect(UNDO_FAILED_NOTICE).not.toContain("受け取り済み");
  });

});
