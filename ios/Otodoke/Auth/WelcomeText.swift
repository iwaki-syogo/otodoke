// The words of the first screen (before the login). The headline and the lede are the Web top page's
// (src/app/page.tsx, word for word; a vitest compares them). The button words are the app's own.

import Foundation

enum WelcomeText {
    // MARK: the Web top page's words (src/app/page.tsx)

    /// The h1, in its two lines.
    static let headlineFirst = "荷物に、"
    static let headlineSecond = "予定を合わせない。"
    /// The paragraph under the h1.
    static let lede = "どの店で買った荷物も、いつ届くか・いつ家にいればいいかが 1 つのカレンダーに並びます。設定は最初の 1 回だけ。"

    // MARK: the app's own

    /// The big button, and the small line inside it.
    static let newHere = "はじめての方"
    static let newHereNote = "アカウントを作る"
    /// The second button.
    static let signIn = "ログイン"
}
