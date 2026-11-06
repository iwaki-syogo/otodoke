// The months the calendar and the spend screen may show: MONTH_MIN ("2020-01") to monthMax(today), and
// the picker of src/app/app/month-picker.tsx with the page's 「‹ 前月」「翌月 ›」 around it: the month's
// name opens a wheel of the year and the month only (sent once, when 「完了」 is pressed). One move at a
// time: while one is on the way every control waits, and the pressed one shows a spinner.

import SwiftUI

struct MonthBounds: Equatable, Sendable {
    let min: String
    let max: String

    init(today: String) {
        min = Format.monthMin
        max = Format.monthMax(today: today)
    }

    /// A month "YYYY-MM" (01 to 12) from min to max, compared as text.
    func contains(_ ym: String) -> Bool {
        guard !ym.isEmpty, JSText.equal(Format.monthParam(ym, today: ""), ym) else { return false }
        return !JSText.less(ym, min) && !JSText.less(max, ym)
    }

    /// `ym` moved by `delta` months stays inside.
    func canShift(_ ym: String, by delta: Int) -> Bool {
        contains(ym) && contains(Format.shiftMonth(ym, delta))
    }

    /// Every month of the wheel, oldest first (min ... max).
    var months: [String] {
        guard contains(min), contains(max) else { return [] }
        var out: [String] = []
        var month = min
        while !JSText.less(max, month) {
            out.append(month)
            let next = Format.shiftMonth(month, 1)
            guard !next.isEmpty, JSText.less(month, next), out.count < 12_000 else { break }
            month = next
        }
        return out
    }
}

/// 「‹ 前月」, the month's name (a wheel of the year and the month), 「翌月 ›」.
struct MonthPicker: View {
    /// "YYYY-MM" shown.
    let month: String
    let today: String
    let bounds: MonthBounds
    /// A move (of this header or of anything else on the screen) is on the way.
    let isMoving: Bool
    /// Moves to the month given (inside the bounds).
    let move: (String) -> Void

    private enum Control { case back, picker, forward }

    @State private var pressed: Control?
    @State private var isPicking = false

    var body: some View {
        HStack {
            Button {
                go(.back, Format.shiftMonth(month, -1))
            } label: {
                HStack(spacing: 4) {
                    spinnerOr(.back, "‹")
                    Text("前月")
                }
            }
            .disabled(isMoving || !bounds.canShift(month, by: -1))
            .accessibilityLabel("前の月")

            Spacer(minLength: 8)

            Button {
                isPicking = true
            } label: {
                HStack(spacing: 4) {
                    Text(Format.monthLabel(month, today: today))
                        .font(.headline)
                        .foregroundStyle(.primary)
                    if isMoving && pressed == .picker {
                        ProgressView().controlSize(.mini)
                    } else {
                        Text("▾").font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            .disabled(isMoving)
            .accessibilityLabel("月を選ぶ")

            Spacer(minLength: 8)

            Button {
                go(.forward, Format.shiftMonth(month, 1))
            } label: {
                HStack(spacing: 4) {
                    Text("翌月")
                    spinnerOr(.forward, "›")
                }
            }
            .disabled(isMoving || !bounds.canShift(month, by: 1))
            .accessibilityLabel("次の月")
        }
        .font(.subheadline)
        .foregroundStyle(.secondary)
        .buttonStyle(.plain)
        .onChange(of: isMoving) { _, moving in
            if !moving { pressed = nil }
        }
        .sheet(isPresented: $isPicking) {
            MonthWheel(month: month, bounds: bounds) { picked in
                isPicking = false
                if let picked, !JSText.equal(picked, month) { go(.picker, picked) }
            }
            .presentationDetents([.height(300)])
        }
    }

    @ViewBuilder
    private func spinnerOr(_ control: Control, _ mark: String) -> some View {
        if isMoving && pressed == control {
            ProgressView().controlSize(.mini)
        } else {
            Text(mark)
        }
    }

    private func go(_ control: Control, _ target: String) {
        guard !isMoving, bounds.contains(target) else { return }
        pressed = control
        move(target)
    }
}

/// The wheels: the year and the month only, inside the bounds.
private struct MonthWheel: View {
    let bounds: MonthBounds
    /// The month picked (「完了」), or nil (「キャンセル」).
    let done: (String?) -> Void

    @State private var year: Int
    @State private var monthNumber: Int

    init(month: String, bounds: MonthBounds, done: @escaping (String?) -> Void) {
        self.bounds = bounds
        self.done = done
        let parts = Format.splitDate("\(month)-01")
        _year = State(initialValue: parts?.y ?? 2020)
        _monthNumber = State(initialValue: parts?.m ?? 1)
    }

    private var years: [Int] {
        let first = Format.splitDate("\(bounds.min)-01")?.y ?? 2020
        let last = Format.splitDate("\(bounds.max)-01")?.y ?? first
        return first <= last ? Array(first...last) : []
    }

    private func ym(_ y: Int, _ m: Int) -> String {
        "\(JSText.pad(y, 4))-\(JSText.pad(m, 2))"
    }

    private var monthsOfYear: [Int] {
        (1...12).filter { bounds.contains(ym(year, $0)) }
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Button("キャンセル") { done(nil) }
                Spacer()
                Button("完了") {
                    let picked = ym(year, monthNumber)
                    done(bounds.contains(picked) ? picked : nil)
                }
                .fontWeight(.semibold)
            }
            .padding()
            HStack(spacing: 0) {
                Picker("年", selection: $year) {
                    ForEach(years, id: \.self) { Text("\(String($0))年").tag($0) }
                }
                .pickerStyle(.wheel)
                Picker("月", selection: $monthNumber) {
                    ForEach(monthsOfYear, id: \.self) { Text("\($0)月").tag($0) }
                }
                .pickerStyle(.wheel)
            }
            .onChange(of: year) { _, _ in
                // A year at an end may not have the month picked: the nearest one it has.
                let months = monthsOfYear
                if !months.contains(monthNumber), let first = months.first, let last = months.last {
                    monthNumber = monthNumber < first ? first : last
                }
            }
        }
    }
}
