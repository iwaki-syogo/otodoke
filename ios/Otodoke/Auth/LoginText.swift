// The words of the password login (password-v1). TDD-STUB(password-login): every value here is a placeholder
// until the implementation; the tests hold the words.
//  - The Web's: src/lib/login-errors.ts LOGIN_MESSAGES (integrate/password-v1 3449af0) and the password rule of
//    src/lib/crypto/password-v1.ts (PASSWORD_RULE, passwordProblem). Each `static let` is named after the Web's key
//    in lowerCamelCase (credentials, notConfirmed, emailNotAscii, …) so a vitest compares them word for word.
//  - The app's own (no Web screen has them yet): the labels and buttons of the login screen.

import Foundation

enum LoginText {
    // MARK: LOGIN_MESSAGES (the Web's words)

    static let credentials = "TDD-STUB(password-login)"
    static let notConfirmed = "TDD-STUB(password-login)"
    static let rate = "TDD-STUB(password-login)"
    static let captcha = "TDD-STUB(password-login)"
    static let network = "TDD-STUB(password-login)"
    static let other = "TDD-STUB(password-login)"
    static let invalidEmail = "TDD-STUB(password-login)"
    static let emailNotAscii = "TDD-STUB(password-login)"
    static let signupExistsOrSent = "TDD-STUB(password-login)"
    static let confirmationSent = "TDD-STUB(password-login)"
    static let signedOut = "TDD-STUB(password-login)"
    static let staleSession = "TDD-STUB(password-login)"
    static let keyInUseChanged = "TDD-STUB(password-login)"
    static let keyWrapChanged = "TDD-STUB(password-login)"
    static let keyNotPending = "TDD-STUB(password-login)"
    static let keyNotInUse = "TDD-STUB(password-login)"
    static let keyChallengeFailed = "TDD-STUB(password-login)"
    static let keyFailed = "TDD-STUB(password-login)"
    static let invalidInput = "TDD-STUB(password-login)"

    // MARK: the password rule (src/lib/crypto/password-v1.ts)

    /// PASSWORD_RULE.
    static let passwordRule = "TDD-STUB(password-login)"
    /// passwordProblem's three answers.
    static let passwordTooShort = "TDD-STUB(password-login)"
    static let passwordWeak = "TDD-STUB(password-login)"
    static let passwordMismatch = "TDD-STUB(password-login)"

    // MARK: the app's own (not on the Web)

    static let signInTitle = "TDD-STUB(password-login)"
    static let signUpTitle = "TDD-STUB(password-login)"
    static let emailLabel = "TDD-STUB(password-login)"
    static let passwordLabel = "TDD-STUB(password-login)"
    static let passwordAgainLabel = "TDD-STUB(password-login)"
    static let signInButton = "TDD-STUB(password-login)"
    static let signUpButton = "TDD-STUB(password-login)"
    /// Switches to the sign-up form.
    static let toSignUp = "TDD-STUB(password-login)"
    /// Switches back to the sign-in form.
    static let toSignIn = "TDD-STUB(password-login)"
    static let forgotPassword = "TDD-STUB(password-login)"
    /// Shown with not_confirmed: sends the confirmation mail again.
    static let resendConfirmation = "TDD-STUB(password-login)"

    /// Opened in Safari (the reset is done on the Web): https://otodoke.app/login/forgot
    static let forgotPasswordURL = URL(string: "http://otodoke.app/login")!
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

    /// The words for the code (LoginText). TDD-STUB(password-login): answers "" until the implementation.
    var message: String { "" }
}

/// The rule for a new password, on the password as typed (the Web's passwordProblem: NFKC, then 10 code points
/// or more, not weak, the two fields the same after NFKC).
enum PasswordRule {
    static let minLength = 10

    /// TDD-STUB(password-login): answers nil until the implementation.
    static func problem(password: String, again: String) -> String? { nil }

    /// The Web's isWeakPassword on the NFKC form. TDD-STUB(password-login): answers false.
    static func isWeak(_ normalized: String) -> Bool { false }
}
