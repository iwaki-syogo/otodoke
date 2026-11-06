// TDD-STUB(task 18): the passphrase field (SecureField, no autocorrection or capitalization), the
// 「開いています…」 line, the message under the field and the 「保存できないとき」 line. Every word comes from
// UnlockModel / FaceIDText (no other text is added; a vitest checks there is no Japanese literal here).

import SwiftUI

struct UnlockView: View {
    @Bindable var model: UnlockModel
    /// Called after the key opened (the caller then opens its mail).
    var onOpened: () -> Void = {}

    var body: some View {
        EmptyView() // TDD-STUB(task 18)
    }
}
