// The words of the password login (password-v1).
//  - The Web's: src/lib/login-errors.ts LOGIN_MESSAGES (integrate/password-v1 fd0e7d4) and the password rule of
//    src/lib/crypto/password-v1.ts (PASSWORD_RULE, passwordProblem). Each `static let` is named after the Web's key
//    in lowerCamelCase (credentials, notConfirmed, emailNotAscii, …) so a vitest compares them word for word.
//  - The app's own (no Web screen has them yet): the labels and buttons of the login screen.

import Foundation

enum LoginText {
    // MARK: LOGIN_MESSAGES (the Web's words)

    static let credentials = "メールアドレスかパスワードが違います。"
    static let notConfirmed = "メールアドレスの確認がまだです。届いたメールのリンクを開いてください。"
    static let rate = "回数が多いため、しばらく時間をおいてから、もう一度お試しください。"
    static let captcha = "確認が切れました。もう一度お試しください。"
    static let network = "つながりませんでした。少し時間をおいて、もう一度お試しください。"
    static let other = "うまくいきませんでした。もう一度お試しください。"
    static let invalidEmail = "メールアドレスの形式を確認してください。"
    static let emailNotAscii = "半角の英数字と記号だけのメールアドレスをお使いください。"
    static let signupExistsOrSent = "確認のメールを送りました。メールのリンクを開いてから、ログインしてください。"
    static let confirmationSent = "確認のメールを送りました。"
    static let signedOut = "ログインし直してください。"
    static let staleSession = "続けるには、もう一度ログインしてください。"
    static let keyInUseChanged = "ほかの画面で鍵が変わりました。ページを読み込み直してください。"
    static let keyWrapChanged = "ほかの画面でパスワードが変わりました。ページを読み込み直してください。"
    static let keyNotPending = "もう一度、最初からお試しください。"
    static let keyNotInUse = "ページを読み込み直してください。"
    static let keyChallengeFailed = "鍵を確かめられませんでした。もう一度お試しください。"
    static let keyFailed = "保存できませんでした。もう一度お試しください。"
    static let invalidInput = "うまくいきませんでした。ページを読み込み直してください。"
    /// key_not_opened: a sign-in that went through, with a password that does not open the key in use.
    static let keyNotOpened = "このパスワードでは、メールの鍵を開けませんでした。"

    // MARK: the password rule (src/lib/crypto/password-v1.ts)

    /// PASSWORD_RULE.
    static let passwordRule = "10 文字以上。同じ文字のくり返し、1234… や abcd… のような連番、password のようなよくある言葉と数字だけの組み合わせは使えません。"
    /// passwordProblem's three answers.
    static let passwordTooShort = "10 文字以上にしてください"
    static let passwordWeak = "推測されやすいパスワードです。同じ文字のくり返し・連番・よくある言葉は避けてください"
    static let passwordMismatch = "2 回の入力が違います"

    // MARK: the app's own (not on the Web)

    static let signInTitle = "ログイン"
    static let signUpTitle = "アカウントを作る"
    static let emailLabel = "メールアドレス"
    static let passwordLabel = "パスワード"
    static let passwordAgainLabel = "パスワード（もう一度）"
    static let signInButton = "ログイン"
    static let signUpButton = "アカウントを作る"
    /// Switches to the sign-up form.
    static let toSignUp = "アカウントを作る"
    /// Switches back to the sign-in form.
    static let toSignIn = "ログインに戻る"
    static let forgotPassword = "パスワードを忘れた"
    /// Shown with not_confirmed: sends the confirmation mail again.
    static let resendConfirmation = "確認のメールをもう一度送る"

    // MARK: the key does not open, or was never made (the owner's decision 11/6 23:4x)

    /// key_not_opened: a sign-in that went through, with a password that does not open the key in use.
    static let keyNotOpened = "このパスワードでは、メールの鍵を開けませんでした。"
    /// N4: the Web's address_mismatch of LOGIN_MESSAGES: the sign-in made no key for this address (letters outside
    /// ASCII); signing in again does not help.
    static let addressMismatch = "このアカウントでは、メールの鍵を作れませんでした。"
    /// The app's own, after keyNotOpened (the Web's key_not_opened).
    static let webLoginPrompt = "Web でログインしてください。"
    /// The two, shown as one line.
    static var keyNeedsWebLogin: String { keyNotOpened + webLoginPrompt }
    static let openWebLogin = "Web でログイン"
    static let noKeyYet = "メールの鍵がまだできていません。ログインし直すと作れます。"
    static let signInAgain = "ログインし直す"
    /// Opened in Safari: https://otodoke.app/login
    static let webLoginURL = URL(string: "https://otodoke.app/login")!

    /// Opened in Safari (the reset is done on the Web): https://otodoke.app/login/forgot
    static let forgotPasswordURL = URL(string: "https://otodoke.app/login/forgot")!
}

/// The six categories shared with the Web (login-errors.ts CommonFailure), and the address checks.
/// The raw value is the Web's code.
enum LoginFailure: String, Error, Equatable, Sendable, CaseIterable {
    case credentials
    case notConfirmed = "not_confirmed"
    case rate
    case captcha
    case network
    case other
    case invalidEmail = "invalid_email"
    case emailNotAscii = "email_not_ascii"

    /// The words for the code (LoginText).
    var message: String {
        switch self {
        case .credentials: LoginText.credentials
        case .notConfirmed: LoginText.notConfirmed
        case .rate: LoginText.rate
        case .captcha: LoginText.captcha
        case .network: LoginText.network
        case .other: LoginText.other
        case .invalidEmail: LoginText.invalidEmail
        case .emailNotAscii: LoginText.emailNotAscii
        }
    }
}

/// The rule for a new password, on the password as typed (the Web's passwordProblem: NFKC, then 10 code points
/// or more, not weak, the two fields the same after NFKC).
enum PasswordRule {
    static let minLength = 10

    /// The Web's COMMON_WORDS (src/lib/crypto/password-v1.ts).
    private static let commonWords: Set<String> = [
        "password", "passwd", "passw0rd", "qwerty", "qwertyuiop", "asdfghjkl", "zxcvbnm", "qazwsx", "iloveyou",
        "letmein", "welcome", "admin", "administrator", "login", "otodoke", "monkey", "dragon", "sunshine",
        "princess", "football", "baseball", "secret", "pokemon", "aikotoba", "himitsu", "abc", "abcd", "abcde",
    ]

    /// What is wrong with a new password (LoginText's words), or nil when it is fine.
    static func problem(password: String, again: String) -> String? {
        let p = PasswordV1.passwordNorm(password)
        if p.unicodeScalars.count < minLength { return LoginText.passwordTooShort }
        if isWeak(p) { return LoginText.passwordWeak }
        if Array(p.utf8) != Array(PasswordV1.passwordNorm(again).utf8) { return LoginText.passwordMismatch }
        return nil
    }

    /// The Web's isWeakPassword on the NFKC form: one short unit repeated, a run of code points up or down, or a
    /// common word with only digits, spaces, punctuation or symbols around it.
    static func isWeak(_ normalized: String) -> Bool {
        let lower = String(String.UnicodeScalarView(normalized.unicodeScalars.map(lowercaseScalar)))
        let chars = Array(lower.unicodeScalars)
        if chars.count < 2 || isRepetition(chars) || isSequence(chars) { return true }
        let letters = String(String.UnicodeScalarView(chars.filter { !isDigitSpacePunctOrSymbol($0) }))
        return commonWords.contains(letters)
    }

    /// JS toLowerCase for the letters that matter here (A-Z, and Unicode's lowercase mapping of one scalar).
    private static func lowercaseScalar(_ s: Unicode.Scalar) -> Unicode.Scalar {
        let mapped = s.properties.lowercaseMapping.unicodeScalars
        return mapped.count == 1 ? mapped.first! : s
    }

    private static func isRepetition(_ chars: [Unicode.Scalar]) -> Bool {
        for unit in 1...3 where chars.count >= unit * 2 {
            if chars.indices.allSatisfy({ chars[$0] == chars[$0 % unit] }) { return true }
        }
        return false
    }

    private static func isSequence(_ chars: [Unicode.Scalar]) -> Bool {
        func step(_ a: Unicode.Scalar, _ b: Unicode.Scalar) -> Int {
            if a == "9", b == "0" { return 1 }
            if a == "0", b == "9" { return -1 }
            return Int(b.value) - Int(a.value)
        }
        let first = step(chars[0], chars[1])
        guard first == 1 || first == -1 else { return false }
        for i in 1..<chars.count where step(chars[i - 1], chars[i]) != first { return false }
        return true
    }

    /// /[\d\s\p{P}\p{S}]/u: an ASCII digit (JS \d), white space (JS \s), punctuation or a symbol.
    private static func isDigitSpacePunctOrSymbol(_ s: Unicode.Scalar) -> Bool {
        let p = s.properties
        if (0x30...0x39).contains(s.value) || isJSWhiteSpace(s) { return true }
        switch p.generalCategory {
        case .connectorPunctuation, .dashPunctuation, .openPunctuation, .closePunctuation, .initialPunctuation,
             .finalPunctuation, .otherPunctuation, .mathSymbol, .currencySymbol, .modifierSymbol, .otherSymbol:
            return true
        default:
            return false
        }
    }

    /// [A3-2] JavaScript's \s (ECMA-262, CharacterClassEscape :: s = WhiteSpace or LineTerminator, §12.2 and
    /// §12.3; with the u flag the same set), which password-v1.ts isWeakPassword removes (src/lib/crypto/
    /// password-v1.ts, /[\d\s\p{P}\p{S}]/gu). Not Unicode's White_Space (Swift's isWhitespace): that holds U+0085
    /// and not U+FEFF. WhiteSpace: U+0009 TAB, U+000B VT, U+000C FF, U+FEFF ZWNBSP, and every Zs (U+0020, U+00A0,
    /// U+1680, U+2000–U+200A, U+202F, U+205F, U+3000); LineTerminator: U+000A LF, U+000D CR, U+2028 LS, U+2029 PS.
    /// The list was checked against Node's /\s/u over every code point.
    static func isJSWhiteSpace(_ s: Unicode.Scalar) -> Bool {
        switch s.value {
        case 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0x1680, 0x2000...0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
            return true
        default:
            return false
        }
    }
}
