import Foundation
import Testing
@testable import Otodoke

/// [password-login] The words. The Web's (LOGIN_MESSAGES of src/lib/login-errors.ts and the password rule of
/// src/lib/crypto/password-v1.ts, integrate/password-v1 3449af0) word for word; a vitest (ios-password-login)
/// compares the same constants with the Web's file, so a change on either side fails one of the two.
/// 「合言葉」 is gone from every word the app shows; the password field, Face ID and the unlock words say パスワード.
/// signInEmail (the address the password opens the key with) is the signed-in session's user.email.
@Suite("Password login: the words and the unlock address (password-login)")
@MainActor
struct PasswordWordsTests {
    // MARK: LOGIN_MESSAGES

    @Test func theSixCategoriesAreTheWebs() {
        #expect(LoginText.credentials == "メールアドレスかパスワードが違います。")
        #expect(LoginText.notConfirmed == "メールアドレスの確認がまだです。届いたメールのリンクを開いてください。")
        #expect(LoginText.rate == "回数が多いため、しばらく時間をおいてから、もう一度お試しください。")
        #expect(LoginText.captcha == "確認が切れました。もう一度お試しください。")
        #expect(LoginText.network == "つながりませんでした。少し時間をおいて、もう一度お試しください。")
        #expect(LoginText.other == "うまくいきませんでした。もう一度お試しください。")
    }

    @Test func theAddressAndTheMailWordsAreTheWebs() {
        #expect(LoginText.invalidEmail == "メールアドレスの形式を確認してください。")
        #expect(LoginText.emailNotAscii == "半角の英数字と記号だけのメールアドレスをお使いください。")
        #expect(LoginText.signupExistsOrSent == "確認のメールを送りました。メールのリンクを開いてから、ログインしてください。")
        #expect(LoginText.confirmationSent == "確認のメールを送りました。")
        #expect(LoginText.signedOut == "ログインし直してください。")
        #expect(LoginText.staleSession == "続けるには、もう一度ログインしてください。")
    }

    @Test func theKeyStepWordsAreTheWebs() {
        #expect(LoginText.keyInUseChanged == "ほかの画面で鍵が変わりました。ページを読み込み直してください。")
        #expect(LoginText.keyWrapChanged == "ほかの画面でパスワードが変わりました。ページを読み込み直してください。")
        #expect(LoginText.keyNotPending == "もう一度、最初からお試しください。")
        #expect(LoginText.keyNotInUse == "ページを読み込み直してください。")
        #expect(LoginText.keyChallengeFailed == "鍵を確かめられませんでした。もう一度お試しください。")
        #expect(LoginText.keyFailed == "保存できませんでした。もう一度お試しください。")
        #expect(LoginText.invalidInput == "うまくいきませんでした。ページを読み込み直してください。")
    }

    @Test func eachFailureShowsItsCodesWords() {
        #expect(LoginFailure.credentials.message == LoginText.credentials)
        #expect(LoginFailure.notConfirmed.message == LoginText.notConfirmed)
        #expect(LoginFailure.rate.message == LoginText.rate)
        #expect(LoginFailure.captcha.message == LoginText.captcha)
        #expect(LoginFailure.network.message == LoginText.network)
        #expect(LoginFailure.other.message == LoginText.other)
        #expect(LoginFailure.invalidEmail.message == LoginText.invalidEmail)
        #expect(LoginFailure.emailNotAscii.message == LoginText.emailNotAscii)
        // The raw value is the Web's code.
        #expect(LoginFailure.allCases.map(\.rawValue) == ["credentials", "not_confirmed", "rate", "captcha", "network", "other", "invalid_email", "email_not_ascii"])
    }

    @Test func thePasswordRuleIsTheWebs() {
        #expect(LoginText.passwordRule == "10 文字以上。同じ文字のくり返し、1234… や abcd… のような連番、password のようなよくある言葉と数字だけの組み合わせは使えません。")
        #expect(LoginText.passwordTooShort == "10 文字以上にしてください")
        #expect(LoginText.passwordWeak == "推測されやすいパスワードです。同じ文字のくり返し・連番・よくある言葉は避けてください")
        #expect(LoginText.passwordMismatch == "2 回の入力が違います")
    }

    /// The app's own words (no Web screen has them yet): short labels, never 「合言葉」, never an explanation.
    @Test func theAppsOwnLoginWords() {
        #expect(LoginText.signInTitle == "ログイン")
        #expect(LoginText.signUpTitle == "アカウントを作る")
        #expect(LoginText.emailLabel == "メールアドレス")
        #expect(LoginText.passwordLabel == "パスワード")
        #expect(LoginText.passwordAgainLabel == "パスワード（もう一度）")
        #expect(LoginText.signInButton == "ログイン")
        #expect(LoginText.signUpButton == "アカウントを作る")
        #expect(LoginText.toSignUp == "アカウントを作る")
        #expect(LoginText.toSignIn == "ログインに戻る")
        #expect(LoginText.forgotPassword == "パスワードを忘れた")
        #expect(LoginText.resendConfirmation == "確認のメールをもう一度送る")
    }

    // MARK: the unlock and Face ID words

    @Test func theUnlockWordsSayPassword() {
        #expect(UnlockModel.placeholder == "パスワード")
        #expect(UnlockModel.openText == "開く")
        #expect(UnlockModel.openingText == "開いています…")
        #expect(UnlockModel.wrongPassphraseText == "パスワードが違います。")
        #expect(UnlockModel.oldKeyText == "前の鍵で暗号化したメールです。開けません。")
        #expect(UnlockModel.readFailedText == "読み込めませんでした")
        #expect(UnlockModel.failedText == "開けませんでした")
    }

    @Test func theFaceIDLineOverTheFieldSaysPassword() {
        #expect(FaceIDText.passphraseField(nil) == "パスワードで開きます。アプリを離れるまで覚えます。")
        #expect(FaceIDText.passphraseField(.faceID) == "パスワードで開きます。次からは Face ID で開けます。")
        #expect(FaceIDText.passphraseField(.touchID) == "パスワードで開きます。次からは Touch ID で開けます。")
        // Unchanged: the usage description has no 「合言葉」.
        #expect(FaceIDText.usageDescription == "メールを開く鍵を Face ID で守って、この端末だけに保存します。")
    }

    @Test func noWordTheAppShowsSaysAikotoba() {
        let shown = [
            UnlockModel.placeholder, UnlockModel.wrongPassphraseText, UnlockModel.oldKeyText,
            FaceIDText.passphraseField(nil), FaceIDText.passphraseField(.faceID), FaceIDText.passphraseField(.touchID),
            FaceIDText.cannotSave(nil), FaceIDText.cannotSave(.faceID), FaceIDText.toggle(.faceID),
            SettingsModel.oldKeyText(3), MailBody.droppedDetail,
        ] + LoginFailure.allCases.map(\.message) + KeyAPIFailure.allCases.map(\.message)
        for words in shown {
            #expect(!words.contains("合言葉"), "\(words)")
        }
    }

    // MARK: the address the password opens the key with

    @Test func theUnlockAddressIsTheSessionsAddress() async throws {
        let fake = FakeSupabase.make()
        await fake.addPasswordAccount(email: FakeSupabase.email, secret: "s")
        let auth = PW.auth(fake)
        // Signed in through supabase-swift itself: no PasswordSignIn is waiting, so no key step starts.
        try await auth.provider.auth.signIn(email: FakeSupabase.email, password: "s")
        await auth.start()
        let screens = MainScreens.live(auth: auth)
        let unlock = try #require(screens.unlock)
        #expect(unlock.signInEmail() == FakeSupabase.email)
        #expect(screens.keySetup != nil)
        await auth.signOut()
        #expect(unlock.signInEmail() == "")
    }
}
