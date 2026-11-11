// The カレンダー tab (src/app/app/calendar/page.tsx, 2541793): 「‹ 前月」 / the month / 「翌月 ›」, the
// month's grid (Sunday red, Saturday sky, today in a black circle, 「N件」 and the red 「🤝N件」), then the
// days still ahead with their parcels, and 「受け取り済み」 at the end. A day of the grid with parcels
// scrolls to that day.

import SwiftUI

/// Where the カレンダー tab navigates.
enum CalendarRoute: Hashable {
    case parcel(id: String)
    case delivered
}

struct CalendarView<Detail: View>: View {
    @Bindable var model: CalendarModel
    /// The detail screen of a parcel.
    @ViewBuilder let detail: (String) -> Detail

    @State private var path: [CalendarRoute] = []
    /// The delivered page (MainTabView hands it down).
    @Environment(\.statusPages) private var pages

    var body: some View {
        NavigationStack(path: $path) {
            content
                .navigationTitle("カレンダー")
                .navigationBarTitleDisplayMode(.inline)
                .navigationDestination(for: CalendarRoute.self) { route in
                    switch route {
                    case let .parcel(id): detail(id)
                    case .delivered:
                        if let pages {
                            StatusPage(pages.delivered, .delivered, pages.refresher, in: .calendar, refresh: { await $0.sceneBecameActive() }, ifStale: { await $0.onAppear() }) { model in
                                DeliveredView(model: model, detail: detail)
                            }
                        }
                    }
                }
        }
        .task { await model.onAppear() }
    }

    private var content: some View {
        ScrollViewReader { scroller in
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    MonthPicker(month: model.month, today: model.shownToday, bounds: model.bounds, isMoving: model.isMoving) { target in
                        Task { await model.show(month: target) }
                    }
                    grid { day in
                        withAnimation { scroller.scrollTo(Self.anchor(day), anchor: .top) }
                    }
                    days
                    PageLinkRow(label: "受け取り済み") { path.append(.delivered) }
                }
                .padding(16)
            }
            .refreshableToTheEnd { await model.load() }
        }
        .background(Color(.systemGroupedBackground))
    }

    private static func anchor(_ day: String) -> String { "d-\(day)" }

    // MARK: the grid

    private func grid(open: @escaping (String) -> Void) -> some View {
        let columns = Array(repeating: GridItem(.flexible(), spacing: 0), count: 7)
        return VStack(spacing: 0) {
            LazyVGrid(columns: columns, spacing: 0) {
                ForEach(Array(CalendarColor.weekdays.enumerated()), id: \.offset) { i, w in
                    Text(w)
                        .font(.system(size: 11))
                        .foregroundStyle(i == 0 ? CalendarColor.sunday : i == 6 ? CalendarColor.saturday : .secondary)
                        .padding(.vertical, 4)
                }
            }
            LazyVGrid(columns: columns, spacing: 4) {
                ForEach(Array(model.cells.enumerated()), id: \.offset) { _, cell in
                    if let cell {
                        DayCell(cell: cell) { open(cell.day) }
                    } else {
                        Color.clear.frame(minHeight: 64)
                    }
                }
            }
        }
        .padding(8)
        .background(Color(.systemBackground), in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(Color(.separator).opacity(0.6)))
    }

    // MARK: the days

    @ViewBuilder
    private var days: some View {
        switch model.byDay {
        case nil:
            ProgressView().frame(maxWidth: .infinity).padding(.vertical, 24)
        case .failed?:
            Text(CalendarModel.failedText)
                .font(.subheadline)
                .foregroundStyle(OtodokeColor.errorText)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(16)
                .background(Palette.errorBackground, in: RoundedRectangle(cornerRadius: 16))
                .overlay(RoundedRectangle(cornerRadius: 16).stroke(Palette.errorBorder))
        case .loaded?:
            if model.listedDays.isEmpty {
                Text(CalendarModel.emptyText)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 24)
            } else {
                VStack(alignment: .leading, spacing: 20) {
                    ForEach(model.listedDays, id: \.self) { day in
                        daySection(day).id(Self.anchor(day))
                    }
                }
            }
        }
    }

    private func daySection(_ day: String) -> some View {
        let isToday = JSText.equal(day, model.shownToday)
        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text(Format.formatDateJa(day, today: model.shownToday))
                    .font(.subheadline.bold())
                    .foregroundStyle(isToday ? .primary : .secondary)
                if isToday {
                    Text("今日")
                        .font(.system(size: 10))
                        .foregroundStyle(Color(.systemBackground))
                        .padding(.horizontal, 8)
                        .padding(.vertical, 2)
                        .background(Color.primary, in: Capsule())
                }
                if let label = model.presenceLabel(on: day) {
                    Text(label)
                        .font(.system(size: 11, weight: .bold))
                        .foregroundStyle(CalendarColor.presenceText)
                }
            }
            ForEach(model.entries(on: day)) { p in
                Button {
                    path.append(.parcel(id: p.id))
                } label: {
                    EntryRow(parcel: p, today: model.shownToday)
                }
                .buttonStyle(.plain)
            }
        }
    }
}

/// One day of the grid.
private struct DayCell: View {
    let cell: CalendarCell
    let open: () -> Void

    var body: some View {
        let content = VStack(spacing: 4) {
            Text("\(cell.number)")
                .font(.subheadline.weight(cell.style == .today ? .bold : .regular))
                .foregroundStyle(numberColor)
                .frame(width: 24, height: 24)
                .background(cell.style == .today ? Color.primary : Color.clear, in: Circle())
            if let badge = cell.badge {
                Text(badge)
                    .font(.system(size: 10, weight: cell.isFaceToFace ? .bold : .regular))
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .foregroundStyle(cell.isFaceToFace ? Color.white : CalendarColor.countText)
                    .frame(maxWidth: .infinity)
                    .padding(.horizontal, 2)
                    .background(cell.isFaceToFace ? OtodokeColor.hex("#dc2626") : CalendarColor.countBackground, in: RoundedRectangle(cornerRadius: 4))
            }
        }
        .padding(.horizontal, 2)
        .padding(.vertical, 4)
        .frame(maxWidth: .infinity, minHeight: 64, alignment: .top)

        if cell.count > 0 {
            Button(action: open) { content.contentShape(Rectangle()) }
                .buttonStyle(.plain)
                .accessibilityLabel("\(cell.number)日 \(cell.badge ?? "")")
        } else {
            content
        }
    }

    private var numberColor: Color {
        switch cell.style {
        case .today: Color(.systemBackground)
        case .sunday: CalendarColor.sunday
        case .saturday: CalendarColor.saturday
        case .plain: .primary
        }
    }
}

/// A parcel of a day: the time, the shop, the title, the status and face-to-face.
private struct EntryRow: View {
    let parcel: ParcelRow
    let today: String

    var body: some View {
        let time = CalendarModel.timeText(parcel, today: today)
        HStack(alignment: .top, spacing: 12) {
            Text(time)
                .font(.subheadline.weight(time == CalendarModel.noTime ? .regular : .bold))
                .foregroundStyle(time == CalendarModel.noTime ? .secondary : .primary)
                .frame(width: 80, alignment: .leading)
            VStack(alignment: .leading, spacing: 2) {
                Text(parcel.shop)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Text(parcel.title ?? "品名の記載なし")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.primary)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                HStack(spacing: 6) {
                    StatusBadge(status: parcel.status, receivedAt: parcel.receivedAt)
                    PresenceBadge(parcel: parcel, compact: true)
                }
                .padding(.top, 4)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(12)
        .background(Color(.systemBackground), in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color(.separator).opacity(0.6)))
        .contentShape(RoundedRectangle(cornerRadius: 12))
    }
}

/// The calendar's colours (Tailwind's red-600, sky-700, sky-100 / sky-900, red-700), with a dark pair.
enum CalendarColor {
    static let weekdays = ["日", "月", "火", "水", "木", "金", "土"]
    static let sunday = OtodokeColor.adaptive(light: "#dc2626", dark: "#f87171")
    static let saturday = OtodokeColor.adaptive(light: "#0369a1", dark: "#38bdf8")
    static let countBackground = OtodokeColor.adaptive(light: "#e0f2fe", dark: "#082f49")
    static let countText = OtodokeColor.adaptive(light: "#0c4a6e", dark: "#bae6fd")
    static let presenceText = OtodokeColor.adaptive(light: "#b91c1c", dark: "#fca5a5")
}
