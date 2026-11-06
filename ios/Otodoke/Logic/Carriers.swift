// Port of src/lib/carriers/index.ts. The carrier is decided by rules (the number's shape and a carrier
// name near it), never by the model.

import Foundation

enum CarrierKey: String, CaseIterable, Sendable {
    case yamato, sagawa, japanpost, amazon, seino, fukutsu, unknown
}

struct CarrierInfo: Equatable, Sendable {
    let key: CarrierKey
    let name: String
}

/// TrackingLink: open (a link), post (a form to submit), copy (copy the number, then open the page).
enum TrackingLink: Equatable, Sendable {
    case open(url: String)
    case post(url: String, fields: [String: String])
    case copy(url: String, pageName: String)
}

enum Carriers {
    /// Keep letters and digits only (ASCII, as `[^0-9A-Za-z]`), upper-cased.
    static func normalizeTracking(_ raw: String) -> String {
        var out = ""
        for s in raw.unicodeScalars {
            switch s.value {
            case 0x30...0x39, 0x41...0x5A: out.unicodeScalars.append(s)
            case 0x61...0x7A: out.unicodeScalars.append(Unicode.Scalar(s.value - 0x20)!)
            default: break
            }
        }
        return out
    }

    /// Decide the carrier from the number's shape and, where the shape is ambiguous, from the hint.
    static func identifyCarrier(_ tracking: String?, hint: String?) -> CarrierInfo {
        let hinted: CarrierKey? = {
            guard let hint, !hint.isEmpty else { return nil }
            return hinted(hint)
        }()
        let n = tracking.map { $0.isEmpty ? "" : normalizeTracking($0) } ?? ""
        let u = Array(n.utf16)

        if u.count >= 12 && u.count <= 16 && u.starts(with: Array("TBA".utf16)) && allDigits(u[3...]) {
            return info(.amazon)
        }
        if u.count == 13 && allUpper(u[0..<2]) && allDigits(u[2..<11]) && u[11] == 0x4A && u[12] == 0x50 {
            return info(.japanpost) // EMS / international
        }
        if allDigits(u[...]) {
            switch u.count {
            case 12: return info(hinted ?? .unknown)
            case 11, 13: return info(hinted ?? .japanpost)
            case 10: return info(hinted ?? .unknown)
            default: break
            }
        }
        return info(hinted ?? .unknown)
    }

    /// How to look a number up on the carrier's site, or nil when the carrier has no public lookup.
    static func trackingLinkFor(_ tracking: String?, hint: String?) -> TrackingLink? {
        guard let tracking, !tracking.isEmpty else { return nil }
        let n = normalizeTracking(tracking)
        if n.isEmpty { return nil }
        switch identifyCarrier(tracking, hint: hint).key {
        case .yamato:
            return .post(url: "https://toi.kuronekoyamato.co.jp/cgi-bin/tneko", fields: ["category": "1", "number01": n])
        case .sagawa:
            return .copy(url: "https://e-customer.sagawa-exp.co.jp/k2k", pageName: "佐川のお荷物お問い合わせサービス")
        case .japanpost:
            return .open(url: "https://trackings.post.japanpost.jp/services/srv/search/direct?reqCodeNo1=\(n)&searchKind=S002&locale=ja")
        case .seino:
            return .post(url: "https://track.seino.co.jp/kamotsu/gempyoNoShokaiSpn.do", fields: ["action": "InquirySpn", "GNPNO1": n])
        case .fukutsu:
            return .open(url: "https://corp.fukutsu.co.jp/situation/tracking_no_hunt/\(n)")
        case .amazon, .unknown:
            return nil
        }
    }

    /// Amazon's own tracking page for a Japanese Amazon order number (250-1234567-1234567), else nil.
    static func amazonOrderTrackingUrl(_ orderNumber: String?) -> String? {
        let n = JSText.trim(orderNumber ?? "")
        let u = Array(n.utf16)
        guard u.count == 19, u[3] == 0x2D, u[11] == 0x2D,
              allDigits(u[0..<3]), allDigits(u[4..<11]), allDigits(u[12..<19]) else { return nil }
        // Digits and hyphens only, so encodeURIComponent leaves the number as it is.
        return "https://www.amazon.co.jp/gp/your-account/ship-track?orderId=\(n)"
    }

    // MARK: - Private

    private static func info(_ key: CarrierKey) -> CarrierInfo {
        switch key {
        case .yamato: return CarrierInfo(key: key, name: "ヤマト運輸")
        case .sagawa: return CarrierInfo(key: key, name: "佐川急便")
        case .japanpost: return CarrierInfo(key: key, name: "日本郵便")
        case .amazon: return CarrierInfo(key: key, name: "Amazon配送")
        case .seino: return CarrierInfo(key: key, name: "西濃運輸")
        case .fukutsu: return CarrierInfo(key: key, name: "福山通運")
        case .unknown: return CarrierInfo(key: key, name: "不明")
        }
    }

    /// HINTS, in order. The Web's patterns are alternations of literal words under the `i` flag
    /// (without `u`), which folds ASCII letters only; so the words are lower case here and the hint's
    /// ASCII letters are lowered before a code-unit search.
    private static let hints: [(words: [String], key: CarrierKey)] = [
        (["ヤマト", "クロネコ", "kuroneko", "yamato"], .yamato),
        (["佐川", "sagawa"], .sagawa),
        (["日本郵便", "ゆうパック", "ゆうパケット", "郵便局", "japanpost", "japan post", "レターパック", "クリックポスト"], .japanpost),
        (["amazon", "アマゾン"], .amazon),
        (["西濃", "seino"], .seino),
        (["福山通運", "fukutsu"], .fukutsu),
    ]

    private static func hinted(_ hint: String) -> CarrierKey? {
        let text = hint.utf16.map { (0x41...0x5A).contains($0) ? $0 + 0x20 : $0 }
        for (words, key) in hints where words.contains(where: { contains(text, Array($0.utf16)) }) {
            return key
        }
        return nil
    }

    private static func contains(_ text: [UInt16], _ word: [UInt16]) -> Bool {
        guard !word.isEmpty, word.count <= text.count else { return word.isEmpty }
        for start in 0...(text.count - word.count) where text[start..<(start + word.count)].elementsEqual(word) {
            return true
        }
        return false
    }

    private static func allDigits(_ units: ArraySlice<UInt16>) -> Bool {
        !units.isEmpty && units.allSatisfy { (0x30...0x39).contains($0) }
    }

    private static func allUpper(_ units: ArraySlice<UInt16>) -> Bool {
        !units.isEmpty && units.allSatisfy { (0x41...0x5A).contains($0) }
    }
}
