// Port of src/lib/delivered.ts (2541793): groupByOrderMonth, NO_ORDER_DATE_LABEL, itemNamesByParcel,
// searchWord (JS trim, then the first SEARCH_MAX UTF-16 units), filterDelivered (the word, the title, the
// shop, normalizeShop and the item names folded by NFKC then JS toLowerCase; a value that cannot narrow is
// left out), deliveredFilterOptions, monthChoices. Code-unit order, stable sorts, Asia/Tokyo nowhere needed.

import Foundation

/// parcel_items(parcel_id, name).
struct ParcelItemName: Codable, Equatable, Sendable {
    let parcelId: String
    let name: String

    enum CodingKeys: String, CodingKey {
        case parcelId = "parcel_id"
        case name
    }
}

/// ?q= ?s= ?c= ?m= (nil is not given; "" is given empty, as the page passes it).
struct DeliveredFilterValues: Equatable, Sendable {
    var q: String?
    var s: String?
    var c: String?
    var m: String?

    init(q: String? = nil, s: String? = nil, c: String? = nil, m: String? = nil) {
        self.q = q
        self.s = s
        self.c = c
        self.m = m
    }
}

struct DeliveredCategoryOption: Equatable, Sendable {
    let value: String
    let label: String
}

struct DeliveredFilterOptions: Equatable, Sendable {
    let shops: [String]
    let months: [String]
    let categories: [DeliveredCategoryOption]
}

enum Delivered {
    static let noOrderDateLabel = "注文日不明"
    static let searchMax = 100

    /// Newest month first, 「2026年5月に注文」; within a month the newest order date first (stable);
    /// no order date last under 「注文日不明」. The spend screen's copy is the same function.
    static func groupByOrderMonth(_ parcels: [ParcelRow]) -> [(label: String, parcels: [ParcelRow])] {
        Spend.groupByOrderMonth(parcels)
    }

    /// Item names by parcel id, in input order.
    static func itemNamesByParcel(_ items: [ParcelItemName]) -> [String: [String]] {
        var out: [String: [String]] = [:]
        for it in items {
            out[it.parcelId, default: []].append(it.name)
        }
        return out
    }

    /// `(q ?? "").trim().slice(0, SEARCH_MAX)`.
    static func searchWord(_ q: String?) -> String {
        let trimmed = JSText.trim(q ?? "")
        return JSText.slice(trimmed, 0, searchMax)
    }

    /// `/^\d{4}-(0[1-9]|1[0-2])$/` (ASCII digits, the whole text).
    static func isMonth(_ m: String?) -> Bool {
        guard let m else { return false }
        let u = Array(m.utf16)
        guard u.count == 7, u[4] == 0x2D else { return false }
        func digit(_ c: UInt16) -> Bool { (0x30...0x39).contains(c) }
        guard u[0..<4].allSatisfy(digit), digit(u[5]), digit(u[6]) else { return false }
        if u[5] == 0x30 { return u[6] != 0x30 }
        if u[5] == 0x31 { return (0x30...0x32).contains(u[6]) }
        return false
    }

    static func filterDelivered(_ parcels: [ParcelRow], itemNames: [String: [String]], values: DeliveredFilterValues) -> [ParcelRow] {
        let word = JSText.trim(JSFold.fold(searchWord(values.q)))
        let shop: String? = {
            guard let s = values.s, !s.isEmpty else { return nil }
            return parcels.contains { JSText.equal(Shop.normalizeShop($0), s) } ? s : nil
        }()
        let category = Shop.categoryParam(values.c.map { [$0] })
        let month: String? = isMonth(values.m) ? values.m : nil
        let wordUnits = Array(word.utf16)

        return parcels.filter { p in
            if let shop, !JSText.equal(Shop.normalizeShop(p), shop) { return false }
            switch category {
            case .any: break
            case .uncategorized: if Spend.categoryOf(p.category) != nil { return false }
            case .only(let c): if Spend.categoryOf(p.category) != c { return false }
            }
            if let month, !JSText.equal(JSText.slice(p.orderedAt ?? "", 0, 7), month) { return false }
            if !wordUnits.isEmpty {
                let texts = [p.title ?? "", p.shop, Shop.normalizeShop(p)] + (itemNames[p.id] ?? [])
                if !texts.contains(where: { JSFold.includes(Array(JSFold.fold($0).utf16), wordUnits) }) { return false }
            }
            return true
        }
    }

    /// What the selects offer: the shops and order months in the data, and every category.
    static func deliveredFilterOptions(_ parcels: [ParcelRow]) -> DeliveredFilterOptions {
        var counts: [(name: String, count: Int)] = []
        for p in parcels {
            let name = Shop.normalizeShop(p)
            if let i = counts.firstIndex(where: { JSText.equal($0.name, name) }) {
                counts[i].count += 1
            } else {
                counts.append((name, 1))
            }
        }
        // Most parcels first; ties in plain code-unit order (stable, as Array.prototype.sort is).
        let shops = counts.enumerated()
            .sorted { l, r in
                if l.element.count != r.element.count { return l.element.count > r.element.count }
                if JSText.equal(l.element.name, r.element.name) { return l.offset < r.offset }
                return JSText.less(l.element.name, r.element.name)
            }
            .map(\.element.name)

        var seen: [String] = []
        for p in parcels {
            let ym = JSText.slice(p.orderedAt ?? "", 0, 7)
            if !seen.contains(where: { JSText.equal($0, ym) }) { seen.append(ym) }
        }
        let months = newestFirst(seen.filter { isMonth($0) })

        let categories = ParcelCategory.allCases.map { DeliveredCategoryOption(value: $0.rawValue, label: $0.label) }
            + [DeliveredCategoryOption(value: Shop.none, label: ParcelCategory.uncategorizedLabel)]
        return DeliveredFilterOptions(shops: shops, months: months, categories: categories)
    }

    /// The data's months, plus a well-formed `m` the data does not have. Newest first.
    static func monthChoices(_ months: [String], m: String?) -> [String] {
        guard let m, isMonth(m), !months.contains(where: { JSText.equal($0, m) }) else { return months }
        return newestFirst(months + [m])
    }

    /// `sort((a, b) => a < b ? 1 : a > b ? -1 : 0)`, stable.
    private static func newestFirst(_ values: [String]) -> [String] {
        values.enumerated()
            .sorted { l, r in
                if JSText.equal(l.element, r.element) { return l.offset < r.offset }
                return JSText.less(r.element, l.element)
            }
            .map(\.element)
    }
}

/// `s.normalize("NFKC").toLowerCase()` and `String.prototype.includes`, on UTF-16 code units.
enum JSFold {
    static func fold(_ s: String) -> String {
        lowerCase(nfkc(s))
    }

    /// `s.normalize("NFKC")`. Foundation's compatibility mapping leaves a mark that came out of a
    /// compatibility decomposition uncomposed (half-width 「ﾃﾞ」 stays テ + U+3099); composing canonically
    /// afterwards gives what NFKC gives (「デ」).
    static func nfkc(_ s: String) -> String {
        s.precomposedStringWithCompatibilityMapping.precomposedStringWithCanonicalMapping
    }

    /// String.prototype.toLowerCase: the full lowercase mapping of every code point, with the one
    /// context the language applies (Final_Sigma: a capital sigma after a cased letter and not before one).
    static func lowerCase(_ s: String) -> String {
        let scalars = Array(s.unicodeScalars)
        var out = String.UnicodeScalarView()
        for (i, c) in scalars.enumerated() {
            if c.value == 0x03A3 {
                out.append(isFinalSigma(scalars, at: i) ? "\u{03C2}" : "\u{03C3}")
            } else {
                out.append(contentsOf: c.properties.lowercaseMapping.unicodeScalars)
            }
        }
        return String(out)
    }

    private static func isFinalSigma(_ s: [Unicode.Scalar], at i: Int) -> Bool {
        var j = i - 1
        while j >= 0 && s[j].properties.isCaseIgnorable { j -= 1 }
        guard j >= 0, s[j].properties.isCased else { return false }
        var k = i + 1
        while k < s.count && s[k].properties.isCaseIgnorable { k += 1 }
        return !(k < s.count && s[k].properties.isCased)
    }

    /// `text.includes(word)` on code units.
    static func includes(_ text: [UInt16], _ word: [UInt16]) -> Bool {
        if word.isEmpty { return true }
        guard text.count >= word.count else { return false }
        for start in 0...(text.count - word.count) where text[start] == word[0] {
            if text[start..<(start + word.count)].elementsEqual(word) { return true }
        }
        return false
    }
}
