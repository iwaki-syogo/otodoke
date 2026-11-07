// The sentence of the Gmail approval card that points to the filter text under it: the Web's ApprovalFilterCopy
// (src/components/forwarding-steps.tsx). src/lib/__tests__/ios-gmail-approval-filter.test.ts compares it word for word.
// It lives here, apart from SettingsWebText, whose words are looked up in the Web's settings pages.

import Foundation

enum GmailApprovalText {
    static let filterNote = "承認したら、この文字列をコピーして Gmail に戻り、フィルタの「含む」に貼ります。"
}
