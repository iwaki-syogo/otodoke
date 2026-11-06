// MonthBars of src/app/app/spend/month-bars.tsx: spending per order month as stacked columns (Swift
// Charts), one colour per category in the fixed order, newest month on the right. The y axis
// (axisTicks, tickLabel) stays put while the columns scroll sideways, starting at the newest; the
// year is written under its first month. Tapping a column opens that month.

import Charts
import SwiftUI

struct SpendBarsView: View {
    let months: [Spend.MonthBar]
    /// A move is on the way: the columns wait.
    let isMoving: Bool
    let open: (String) -> Void

    /// The bars' area, as the Web's PLOT.
    private static let plot: CGFloat = 160
    /// Each column's slot (the tap target), as the Web's SLOT; the bar is 20 wide inside it.
    private static let slot: CGFloat = 32
    private static let labels: CGFloat = 30
    /// The y axis' labels.
    private static let axis: CGFloat = 40

    var body: some View {
        if !months.isEmpty {
            let ticks = Spend.axisTicks(Double(months.map(\.total).max() ?? 0))
            let top = ticks.last.map { $0 > 0 ? $0 : 1 } ?? 1
            VStack(alignment: .leading, spacing: 12) {
                // [N1] The columns' window is a whole number of slots (the rest goes to the axis, on its
                // left): scrolled to the newest, the oldest column shown is never cut in half.
                GeometryReader { geometry in
                    let room = max(geometry.size.width - Self.axis, 0)
                    let rest = room.truncatingRemainder(dividingBy: Self.slot)
                    HStack(alignment: .top, spacing: 0) {
                        yAxis(ticks, top: top, width: Self.axis + rest)
                        ScrollViewReader { scroller in
                            ScrollView(.horizontal, showsIndicators: false) {
                                chart(ticks, top: top)
                                    .frame(width: max(Self.slot * CGFloat(months.count), 1), height: Self.plot + Self.labels)
                                    .id("bars")
                            }
                            .defaultScrollAnchor(.trailing)
                            .onAppear { scroller.scrollTo("bars", anchor: .trailing) }
                        }
                        .frame(width: room - rest)
                    }
                }
                .frame(height: Self.plot + Self.labels)
                legend
            }
            .padding(16)
            .background(Color(.systemBackground), in: RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).stroke(Color(.separator).opacity(0.6)))
            .accessibilityElement(children: .contain)
            .accessibilityLabel("月ごとの支出")
        }
    }

    private func yAxis(_ ticks: [Double], top: Double, width: CGFloat) -> some View {
        ZStack(alignment: .bottomTrailing) {
            ForEach(ticks, id: \.self) { t in
                Text(Spend.tickLabel(t))
                    .font(.system(size: 10).monospacedDigit())
                    .foregroundStyle(.secondary)
                    .padding(.trailing, 6)
                    .alignmentGuide(.bottom) { d in d[VerticalAlignment.center] }
                    .offset(y: -CGFloat(t / top) * Self.plot)
            }
        }
        .frame(width: width, height: Self.plot, alignment: .bottomTrailing)
        .accessibilityHidden(true)
    }

    private func chart(_ ticks: [Double], top: Double) -> some View {
        let years = Self.firstOfYear(months.map(\.month))
        return Chart {
            ForEach(months, id: \.month) { m in
                ForEach(Array(m.segments.enumerated()), id: \.offset) { _, s in
                    BarMark(x: .value("月", m.month), y: .value("金額", s.amount), width: .fixed(20))
                        .foregroundStyle(SpendColor.of(s.category))
                }
            }
        }
        .chartXScale(domain: months.map(\.month))
        .chartYScale(domain: 0...top)
        .chartYAxis {
            AxisMarks(values: ticks) { value in
                AxisGridLine(stroke: StrokeStyle(lineWidth: 1))
                    .foregroundStyle(value.as(Double.self) == 0 ? Color(.systemGray3) : Color(.systemGray6))
            }
        }
        .chartXAxis {
            AxisMarks(values: months.map(\.month)) { value in
                AxisValueLabel(centered: true) {
                    if let ym = value.as(String.self) {
                        let parts = Format.splitDate("\(ym)-01")
                        VStack(spacing: 0) {
                            Text("\(parts?.m ?? 0)月")
                                .font(.system(size: 10).monospacedDigit())
                                .foregroundStyle(.secondary)
                            Text(years.contains(ym) ? "\(JSText.slice(ym, 2, 4))年" : " ")
                                .font(.system(size: 9))
                                .foregroundStyle(.tertiary)
                        }
                    }
                }
            }
        }
        .chartPlotStyle { $0.frame(height: Self.plot) }
        .chartOverlay { proxy in
            GeometryReader { geometry in
                Rectangle().fill(.clear).contentShape(Rectangle())
                    .onTapGesture { location in
                        guard !isMoving, let frame = proxy.plotFrame else { return }
                        let x = location.x - geometry[frame].origin.x
                        if let ym: String = proxy.value(atX: x) { open(ym) }
                    }
            }
        }
        .opacity(isMoving ? 0.7 : 1)
    }

    /// The months under which the year is written: each year's first month shown (the oldest too).
    static func firstOfYear(_ months: [String]) -> Set<String> {
        var seen: Set<String> = []
        var out: Set<String> = []
        for ym in months {
            let year = JSText.slice(ym, 0, 4)
            if !seen.contains(year) {
                seen.insert(year)
                out.insert(ym)
            }
        }
        return out
    }

    /// In the stacking order, only the categories that appear.
    private var legend: some View {
        let order: [ParcelCategory?] = ParcelCategory.allCases.map { $0 } + [nil]
        let present = order.filter { c in months.contains { $0.segments.contains { $0.category == c } } }
        return WrappingRow(spacing: 12, lineSpacing: 4) {
            ForEach(Array(present.enumerated()), id: \.offset) { _, c in
                HStack(spacing: 4) {
                    Circle().fill(SpendColor.of(c)).frame(width: 8, height: 8)
                    Text(ParcelCategory.label(for: c?.rawValue))
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                }
            }
        }
    }
}

enum SpendColor {
    /// categoryColor: one of the seven, or 未分類's gray.
    static func of(_ category: ParcelCategory?) -> Color {
        OtodokeColor.hex(category?.colorHex ?? ParcelCategory.uncategorizedColorHex)
    }
}
