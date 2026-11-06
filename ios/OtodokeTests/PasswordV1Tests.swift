import CryptoKit
import Foundation
import Testing
@testable import Otodoke

/// [password-v1] The derivations of docs/crypto/password-v1.md against fixtures/crypto/password-v1.json (all 10
/// cases): email_norm, salt_pw, password_norm (UTF-8), master, auth_secret, KEK, every one byte for byte. Text
/// is compared as UTF-8 bytes only (Swift's == is canonical equivalence and hides a wrong normalization).
/// Negative controls: Foundation's own trimming, lowercasing and compatibility mapping give other bytes.
@Suite("password-v1: the derivations")
struct PasswordV1Tests {
    let v: PasswordV1Vectors

    init() throws {
        v = try PasswordV1Vectors()
    }

    static let caseNames: Set<String> = [
        "ascii", "password_halfwidth_katakana", "password_fullwidth_alnum", "password_combining_mark",
        "password_compatibility_chars", "password_surrounding_spaces", "email_uppercase",
        "email_surrounding_whitespace", "email_non_ascii_whitespace", "email_dotted_capital_i",
    ]

    // MARK: the vector file

    @Test func theVectorFileHoldsTheTenCasesAndTheConstants() {
        #expect(v.cases.count == 10)
        #expect(Set(v.cases.map(\.name)) == Self.caseNames)
        let pbkdf2 = v.constants["pbkdf2"] as? [String: Any] ?? [:]
        #expect(pbkdf2["iterations"] as? Int == 600_000)
        #expect(v.constants["salt_pw_prefix"] as? String == PasswordV1.saltPrefix)
        #expect(v.constants["auth_info"] as? String == PasswordV1.authInfo)
        #expect(v.constants["kek_info"] as? String == PasswordV1.kekInfo)
        #expect(PasswordV1.iterations == 600_000)
        #expect(v.pkcs8.count == 138)
        #expect(v.publicKey.count == 65)
        for c in v.cases {
            #expect(c.master.count == 32, "\(c.name)")
            #expect(c.kek.count == 32, "\(c.name)")
            #expect(c.kdfSalt.count == 16, "\(c.name)")
            #expect(c.wrapIV.count == 12, "\(c.name)")
            #expect(c.wrapTag.count == 16, "\(c.name)")
        }
    }

    @Test func theBundledFileIsTheCanonicalFileByteForByte() throws {
        let bundled = try CryptoVectorFiles.data(PasswordV1Vectors.fileName)
        let canonical = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // OtodokeTests
            .deletingLastPathComponent() // ios
            .deletingLastPathComponent() // the repository
            .appendingPathComponent("fixtures/crypto/password-v1.json")
        let source = try Data(contentsOf: canonical)
        #expect(bundled == source)
        // Negative control: one byte changed is not the same.
        var changed = bundled
        changed[changed.startIndex + 100] ^= 0x01
        #expect(changed != source)
    }

    // MARK: step 1, 2: email_norm and salt_pw

    @Test func emailNormIsTheVectorsBytesInEveryCase() {
        for c in v.cases {
            #expect(utf8Bytes(PasswordV1.emailNorm(c.email)) == utf8Bytes(c.emailNorm), "\(c.name)")
        }
    }

    @Test func saltPWIsTheVectorsBytesInEveryCase() {
        for c in v.cases {
            #expect(PasswordV1.saltPW(email: c.email) == c.saltPW, "\(c.name)")
            #expect(c.saltPW == Data((PasswordV1.saltPrefix + c.emailNorm).utf8), "\(c.name): the vector itself")
        }
    }

    @Test func onlyTheFiveASCIIWhitespacesAreTakenOffAndOnlyAToZLowered() {
        let ascii = "user@example.test"
        #expect(utf8Bytes(PasswordV1.emailNorm(" \t\n\u{0C}\r" + "User@Example.TEST" + "\r\n\t ")) == utf8Bytes(ascii))
        // Not taken off: U+000B, U+0085, U+00A0, U+3000, U+FEFF; nothing between the ends.
        for keep in ["\u{0B}", "\u{85}", "\u{A0}", "\u{3000}", "\u{FEFF}"] {
            #expect(utf8Bytes(PasswordV1.emailNorm(keep + ascii + keep)) == utf8Bytes(keep + ascii + keep), "U+\(String(keep.unicodeScalars.first!.value, radix: 16))")
        }
        #expect(utf8Bytes(PasswordV1.emailNorm("us er@example.test")) == utf8Bytes("us er@example.test"))
        // Not lowered: İ (U+0130), Σ, Ａ (full-width).
        #expect(utf8Bytes(PasswordV1.emailNorm("\u{130}I@X.TEST")) == utf8Bytes("\u{130}i@x.test"))
        #expect(utf8Bytes(PasswordV1.emailNorm("ΣＡ@x.test")) == utf8Bytes("ΣＡ@x.test"))
        #expect(PasswordV1.emailNorm("") == "")
    }

    @Test func anUppercaseOrPaddedAddressIsTheSameAddress() throws {
        let ascii = try #require(v.named("ascii"))
        for name in ["email_uppercase", "email_surrounding_whitespace"] {
            let c = try #require(v.named(name))
            #expect(c.master == ascii.master, "\(name): the vector itself")
            #expect(PasswordV1.saltPW(email: c.email) == ascii.saltPW, "\(name)")
        }
    }

    // MARK: step 3: password_norm

    @Test func passwordNormIsTheVectorsUTF8InEveryCase() {
        for c in v.cases {
            #expect(Data(PasswordV1.passwordNorm(c.password).utf8) == c.passwordNormUTF8, "\(c.name)")
            #expect(Data(c.passwordNorm.utf8) == c.passwordNormUTF8, "\(c.name): the vector itself")
        }
    }

    @Test func thePasswordIsNotTrimmed() throws {
        let c = try #require(v.named("password_surrounding_spaces"))
        let bytes = Data(PasswordV1.passwordNorm(c.password).utf8)
        #expect(bytes.first == 0x20)
        #expect(bytes.last == 0x20)
        #expect(bytes == c.passwordNormUTF8)
    }

    // MARK: step 4, 5, 6: master, auth_secret, KEK

    @Test func masterIsTheVectorsInEveryCase() throws {
        for c in v.cases {
            #expect(try PasswordV1.master(password: c.password, email: c.email) == c.master, "\(c.name)")
        }
    }

    @Test func masterRunsPBKDF2OnceWithTheNormalizedBytesTheSaltAnd600000() throws {
        for c in v.cases {
            let rec = PasswordKDFRecorder()
            #expect(try PasswordV1.master(password: c.password, email: c.email, kdf: rec.kdf) == c.master, "\(c.name)")
            #expect(rec.calls.count == 1, "\(c.name)")
            #expect(rec.calls.first?.password == c.passwordNormUTF8, "\(c.name)")
            #expect(rec.calls.first?.salt == c.saltPW, "\(c.name)")
            #expect(rec.calls.first?.iterations == 600_000, "\(c.name)")
        }
    }

    @Test func pbkdf2TakesASaltOfAnyLength() throws {
        let c = try #require(v.named("ascii"))
        #expect(c.saltPW.count != 16)
        #expect(try PasswordV1.pbkdf2(password: c.passwordNormUTF8, salt: c.saltPW, iterations: 600_000) == c.master)
    }

    @Test func authSecretIsTheVectorsInEveryCase() {
        for c in v.cases {
            let secret = PasswordV1.authSecret(master: c.master)
            #expect(utf8Bytes(secret) == utf8Bytes(c.authSecret), "\(c.name)")
            #expect(secret.utf8.count == 64, "\(c.name)")
            #expect(secret.utf8.allSatisfy { ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x61 && $0 <= 0x66) }, "\(c.name)")
        }
    }

    @Test func kekIsTheVectorsInEveryCase() throws {
        for c in v.cases {
            #expect(try PasswordV1.kek(master: c.master, kdfSalt: c.kdfSalt) == c.kek, "\(c.name)")
        }
    }

    @Test func authSecretAndKEKAreNotTheSameBytes() throws {
        for c in v.cases {
            let kek = try PasswordV1.kek(master: c.master, kdfSalt: c.kdfSalt)
            #expect(kek.count == 32, "\(c.name)")
            #expect(CryptoBytes.toHex(kek) != PasswordV1.authSecret(master: c.master), "\(c.name)")
        }
    }

    @Test func aKdfSaltThatIsNot16BytesIsRefused() throws {
        let c = try #require(v.named("ascii"))
        #expect(caught { try PasswordV1.kek(master: c.master, kdfSalt: c.kdfSalt.prefix(15)) } == .badKeyRow)
        #expect(caught { try PasswordV1.kek(master: c.master, kdfSalt: c.kdfSalt + Data([0])) } == .badKeyRow)
        #expect(caught { try PasswordV1.kek(master: c.master, kdfSalt: Data()) } == .badKeyRow)
    }

    @Test func anotherKdfSaltGivesAnotherKEK() throws {
        let c = try #require(v.named("ascii"))
        var other = c.kdfSalt
        other[other.startIndex] ^= 0x01
        let kek = try PasswordV1.kek(master: c.master, kdfSalt: other)
        #expect(kek.count == 32)
        #expect(kek != c.kek)
    }

    // MARK: negative controls: the platform's own functions

    /// What the spec says not to do: Foundation's trim and Swift's lowercased().
    private func naiveEmailNorm(_ email: String) -> String {
        email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    @Test func foundationsTrimAndLowercasedGiveOtherBytesForSomeCases() {
        let differ = Set(v.cases.filter { utf8Bytes(naiveEmailNorm($0.email)) != utf8Bytes($0.emailNorm) }.map(\.name))
        #expect(differ.isSuperset(of: ["email_non_ascii_whitespace", "email_dotted_capital_i"]), "\(differ)")
        // And where the naive way is wrong, the app's is right.
        for c in v.cases where differ.contains(c.name) {
            #expect(utf8Bytes(PasswordV1.emailNorm(c.email)) != utf8Bytes(naiveEmailNorm(c.email)), "\(c.name)")
            #expect(utf8Bytes(PasswordV1.emailNorm(c.email)) == utf8Bytes(c.emailNorm), "\(c.name)")
        }
    }

    @Test func compatibilityMappingAloneMissesTheHalfWidthVoicedMarks() throws {
        let c = try #require(v.named("password_halfwidth_katakana"))
        let foundationNFKC = c.password.precomposedStringWithCompatibilityMapping
        let nfkd = c.password.decomposedStringWithCompatibilityMapping
        #expect(Data(foundationNFKC.utf8) != c.passwordNormUTF8)
        #expect(Data(nfkd.utf8) != c.passwordNormUTF8)
        // Swift's == says they are equal (canonical equivalence): why every test here compares bytes.
        #expect(foundationNFKC == c.passwordNorm)
        // The spec's recipe gives the bytes.
        #expect(Data(nfkd.precomposedStringWithCanonicalMapping.utf8) == c.passwordNormUTF8)
        // The app's.
        #expect(Data(PasswordV1.passwordNorm(c.password).utf8) == c.passwordNormUTF8)
        #expect(Data(PasswordV1.passwordNorm(c.password).utf8) != Data(foundationNFKC.utf8))
    }

    @Test func theWrongNormalizationGivesAnotherMaster() throws {
        let c = try #require(v.named("password_halfwidth_katakana"))
        let wrong = try PasswordV1.pbkdf2(password: Data(c.password.precomposedStringWithCompatibilityMapping.utf8), salt: c.saltPW, iterations: 600_000)
        #expect(wrong.count == 32)
        #expect(wrong != c.master)
        let right = try PasswordV1.pbkdf2(password: c.passwordNormUTF8, salt: c.saltPW, iterations: 600_000)
        #expect(right == c.master)
    }

    @Test func anotherLetterCaseInThePasswordIsAnotherMaster() throws {
        let c = try #require(v.named("ascii"))
        let other = try PasswordV1.master(password: c.password.uppercased(), email: c.email)
        #expect(other.count == 32)
        #expect(other != c.master)
    }
}
