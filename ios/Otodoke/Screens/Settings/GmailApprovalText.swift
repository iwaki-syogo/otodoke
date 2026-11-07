// The sentence of the Gmail approval card that points to the filter text under it. It is the owner's decision
// and is not on the Web yet; it lives here, apart from SettingsWebText (whose words are all looked up in the Web's
// source), until the Web's constant arrives and a test can compare the two.

import Foundation

enum GmailApprovalText {
    static let filterNote = "フィルタをまだ作っていなければ、「含む」に貼るこの文字列をコピーして Gmail に戻ります。"
}
