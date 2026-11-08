// The tabs after sign-in, in the order and with the names of the Web's tab-bar:
// 荷物 / カレンダー / 支出 / 設定. Every screen shares one DataChanges with the writer (CX1): a write on one
// tab makes the others read again when next shown. Back in front from the background, the screen
// shown reads again, and only that one (iOS-12): the selected tab's top screen (N3).

import SwiftUI

enum MainTab: CaseIterable, Hashable, Sendable {
    case parcels, calendar, spend, settings

    /// 荷物 / カレンダー / 支出 / 設定 (the Web's tab-bar).
    var title: String {
        switch self {
        case .parcels: "荷物"
        case .calendar: "カレンダー"
        case .spend: "支出"
        case .settings: "設定"
        }
    }

    /// The SF Symbol closest to the Web's icon.
    var systemImage: String {
        switch self {
        case .parcels: "shippingbox"
        case .calendar: "calendar"
        case .spend: "yensign"
        case .settings: "slider.horizontal.3"
        }
    }
}

/// Which tab is shown, and the 設定 tab's stack: the empty list's buttons open 「メールの転送」 or 「うまく届かないとき」 straight.
struct TabRoute: Equatable {
    var tab: MainTab = .parcels
    var settingsPath: [SettingsPage] = []

    /// The 設定 tab as it is (the unread-mail notice).
    mutating func showSettings() {
        tab = .settings
    }

    /// The 設定 tab with 「パスワードとメールの鍵」 pushed (the key box's second link).
    mutating func showKey() {
        settingsPath = [.key]
        tab = .settings
    }

    /// The 設定 tab with 「メールの転送」 pushed (replacing what was open there).
    mutating func showForwarding() {
        settingsPath = [.forward]
        tab = .settings
    }

    /// The 設定 tab with 「サンプルで試す」 pushed (the list's busy note).
    mutating func showSample() {
        settingsPath = [.sample]
        tab = .settings
    }

    /// The 設定 tab with 「うまく届かないとき」 pushed (replacing what was open there).
    mutating func showTrouble() {
        settingsPath = [.delivery]
        tab = .settings
    }
}

/// The models of the tabs, made once per sign-in, with one DataChanges and one ScreenRefresher.
@MainActor
final class MainScreens {
    let changes: DataChanges
    let refresher = ScreenRefresher()
    let list: ParcelListModel
    let calendar: CalendarModel
    let spend: SpendModel
    let settings: SettingsModel
    private let makeDetail: (String) -> ParcelDetailModel

    init(
        changes: DataChanges,
        list: ParcelListModel,
        calendar: CalendarModel,
        spend: SpendModel,
        settings: SettingsModel,
        detail: @escaping (String) -> ParcelDetailModel
    ) {
        self.changes = changes
        self.list = list
        self.calendar = calendar
        self.spend = spend
        self.settings = settings
        self.makeDetail = detail
        list.changes = changes
    }

    /// The app's: the signed-in session's provider; the writer publishes to the DataChanges every
    /// screen reads.
    static func live(auth: AuthService, keyParts: KeyParts? = nil, withKeys: Bool = true) -> MainScreens {
        let changes = DataChanges()
        let reader = ParcelReader(provider: auth.provider)
        let writer = ParcelWriter(provider: auth.provider, changes: changes)
        let today: @Sendable () -> String = { Format.todayJst(now: Date()) }
        let screens = MainScreens(
            changes: changes,
            list: .live(reader: reader, writer: writer, readMail: { await SettingsReader(provider: auth.provider).mailSoFar() }),
            calendar: CalendarModel(reader: reader, changes: changes, today: today),
            spend: SpendModel(reader: reader, writer: writer, changes: changes, today: today),
            settings: .live(auth: auth, changes: changes),
            detail: { id in ParcelDetailModel(id: id, reader: reader, writer: writer, today: today) }
        )
        // N-1: withKeys false is a View made while signing out: it must not take AuthService.cleanup over.
        if withKeys { screens.attachKeys(auth: auth, parts: keyParts) }
        return screens
    }

    /// The opened key's store (also AuthService.cleanup), the one UnlockModel every detail uses, and the
    /// settings switch. Set by `live(auth:)` (attachKeys, MainScreens+Keys.swift).
    var keys: OpenKeyStore?
    var unlock: UnlockModel?
    /// The key after a password sign-in (KeySetup), started by attachKeys with auth.takeSignInSecret().
    var keySetup: KeySetup?
    var faceID: FaceIDSwitch?

    /// The delivered page's model, told of the changes.
    func delivered() -> DeliveredModel {
        DeliveredModel(reader: StatusListReader(provider: list.reader.provider), changes: changes)
    }

    /// The cancelled page's model, told of the changes.
    func cancelled() -> CancelledModel {
        CancelledModel(reader: StatusListReader(provider: list.reader.provider), changes: changes)
    }

    /// A parcel's detail model, told of the changes.
    func detail(_ id: String) -> ParcelDetailModel {
        let model = makeDetail(id)
        model.changes = changes
        // Sealed mail opens with the session's one UnlockModel (task 18).
        model.unlock = unlock
        model.mailKeys = MailKeyReader(provider: model.reader.provider)
        return model
    }
}

struct MainTabView: View {
    @State private var route: TabRoute
    /// 「荷物を登録する」 under 「これは荷物」: the form of a parcel typed in by hand, as a sheet.
    @State private var manualForm: ManualParcelModel?
    @State private var screens: MainScreens
    /// The first guide was closed (it is shown once per signed-in generation).
    @State private var guideClosed = false
    /// The key box was left by one of its two links (shown once per signed-in generation).
    @State private var boxClosed = false
    /// The app went to the background since it was last in front.
    @State private var wasInBackground = false
    @Environment(\.scenePhase) private var scenePhase

    /// The signed-in generation's screens (MainScreens.of): the same ones every time this View is made again
    /// (RootView reads scenePhase), so nothing here touches AuthService.cleanup or the sign-in's hand-off (B1-1).
    init(auth: AuthService) {
        self.init(screens: .of(auth))
    }

    /// With models made elsewhere (the DEBUG screen check): the other tabs read through the list's
    /// reader and writer.
    init(listModel: ParcelListModel, detailModel: ((String) -> ParcelDetailModel)? = nil) {
        let reader = listModel.reader
        let writer = listModel.writer
        let changes = writer.changes ?? DataChanges()
        let today: @Sendable () -> String = { Format.todayJst(now: Date()) }
        self.init(screens: MainScreens(
            changes: changes,
            list: listModel,
            calendar: CalendarModel(reader: reader, changes: changes, today: today),
            spend: SpendModel(reader: reader, writer: writer, changes: changes, today: today),
            settings: .live(auth: AuthService(provider: reader.provider), changes: changes),
            detail: detailModel ?? { id in ParcelDetailModel(id: id, reader: reader, writer: writer, today: today) }
        ))
    }

    init(screens: MainScreens, selection: MainTab = .parcels) {
        _screens = State(initialValue: screens)
        _route = State(initialValue: TabRoute(tab: selection))
    }

    private var selection: MainTab { route.tab }

    var body: some View {
        TabView(selection: $route.tab) {
            ForEach(MainTab.allCases, id: \.self) { tab in
                screen(tab)
                    .tabItem { Label(tab.title, systemImage: tab.systemImage) }
                    .tag(tab)
            }
        }
        // [N3] The front is the selected tab's top screen.
        .onChange(of: selection, initial: true) { _, tab in
            screens.refresher.select(tab)
        }
        // S-1: a long load or write finished (the version moved) while another screen was in front: the screen in
        // front reads again if it is stale (the others do so when shown).
        .onChange(of: screens.changes.version) {
            let refresher = screens.refresher
            Task { await refresher.dataChanged() }
        }
        // A sample load went through: the 荷物 tab shows it (with the note while another load is running).
        .onChange(of: screens.settings.demo?.loadedCount) { _, count in
            if count != nil { route.tab = .parcels }
        }
        // The busy note belongs to the 荷物 tab it was shown on.
        .onChange(of: selection) { _, tab in
            if tab != .parcels { screens.settings.demo?.showsBusyNote = false }
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .background:
                wasInBackground = true
                // CX2: the opened key and every opened mail go; work in flight is cancelled.
                screens.keys?.wentToBackground()
            case .active:
                // Back in front (not a system sheet over the app): the screen shown reads again.
                guard wasInBackground else { return }
                wasInBackground = false
                let refresher = screens.refresher
                Task { await refresher.sceneBecameActive() }
            default:
                break
            }
        }
        // The delivered and cancelled pages the 荷物 and カレンダー tabs open (StatusPages.swift).
        .environment(\.statusPages, screens.statusPages)
        // The landing (Landing): the tabs stay built but unseen while the key step of a password sign-in is running,
        // then the guide covers them (no slide, so the tabs are never in view first), or they are shown.
        .opacity(landing == .tabs ? 1 : 0)
        .allowsHitTesting(landing == .tabs)
        .accessibilityHidden(landing != .tabs)
        .overlay {
            switch landing {
            case .waiting:
                ProgressView()
                    .accessibilityLabel(SettingsMenuText.loadingLabel)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Color(.systemBackground).ignoresSafeArea())
                    .ignoresSafeArea()
            case .guide:
                OnboardingView(model: screens.settings) {
                    route.tab = .parcels
                    guideClosed = true
                }
                .transition(.identity)
            case .keyBox:
                KeyBoxView(
                    text: KeyBox.text(for: screens.keySetup?.lastOutcome) ?? "",
                    proceed: {
                        route.tab = .parcels
                        boxClosed = true
                    },
                    openKeyPage: {
                        route.showKey()
                        boxClosed = true
                    }
                )
                .transition(.identity)
            case .tabs:
                EmptyView()
            }
        }
    }

    private var landing: Landing {
        Landing.of(
            deciding: screens.keySetup?.isDeciding == true,
            outcome: screens.keySetup?.lastOutcome,
            guideClosed: guideClosed,
            fromConfirmation: screens.keySetup?.lastRunFromConfirmation == true,
            boxClosed: boxClosed,
            gaveUp: screens.keySetup?.landingGaveUp == true
        )
    }

    @ViewBuilder
    private func screen(_ tab: MainTab) -> some View {
        let screens = self.screens
        switch tab {
        case .parcels:
            let list = screens.list
            ParcelListView(model: list, openSettings: { route.showSettings() }, openForwarding: { route.showForwarding() }, openTrouble: { route.showTrouble() }, openSample: { route.showSample() }) { id in
                TrackedDetail(screens: screens, id: id, tab: .parcels)
            }
            .shownScreen(.parcels, in: .parcels, screens.refresher, refresh: { await list.load() }, ifStale: { await list.onAppear() })
            // Everything was cleared: what the 荷物 tab has open (a parcel's detail, the delivered page) is gone, so the
            // tab starts again from its list.
            .id(screens.settings.demo?.clearedCount ?? 0)
            .safeAreaInset(edge: .top, spacing: 0) {
                if let demo = screens.settings.demo, demo.showsBusyNote {
                    DemoBusyNote { demo.showsBusyNote = false; route.showSample() }
                }
            }
        case .calendar:
            let calendar = screens.calendar
            CalendarView(model: calendar) { id in
                TrackedDetail(screens: screens, id: id, tab: .calendar)
            }
            .shownScreen(.calendar, in: .calendar, screens.refresher, refresh: { await calendar.sceneBecameActive() }, ifStale: { await calendar.onAppear() })
        case .spend:
            let spend = screens.spend
            SpendView(model: spend) { id in
                TrackedDetail(screens: screens, id: id, tab: .spend)
            }
            .shownScreen(.spend, in: .spend, screens.refresher, refresh: { await spend.sceneBecameActive() }, ifStale: { await spend.onAppear() })
        case .settings:
            let settings = screens.settings
            SettingsView(model: settings, path: $route.settingsPath, register: { manualForm = ManualParcelModel.live(list: screens.list) })
                .sheet(item: $manualForm) { form in
                    ManualParcelView(model: form) { manualForm = nil }
                }
                .shownScreen(.settings, in: .settings, screens.refresher) { await settings.sceneBecameActive() }
        }
    }
}

/// A parcel's detail opened from a tab, in front while it is shown.
private struct TrackedDetail: View {
    let refresher: ScreenRefresher
    let tab: MainTab
    @State private var model: ParcelDetailModel
    /// 1 from a tab's root, 2 from a delivered or cancelled page (StatusPage).
    @Environment(\.detailDepth) private var depth

    init(screens: MainScreens, id: String, tab: MainTab) {
        refresher = screens.refresher
        self.tab = tab
        _model = State(initialValue: screens.detail(id))
    }

    var body: some View {
        let model = self.model
        ParcelDetailView(model: model)
            .shownScreen(.detail(model.id), in: tab, depth: depth, refresher, refresh: { [weak model] in await model?.load() }, ifStale: { [weak model] in await model?.onAppear() })
    }
}

/// [N3] One appearance of a screen at a time: a token from `appeared`, given back on `disappeared`
/// (the refresh is let go then).
struct ShownScreen: ViewModifier {
    let id: ScreenID
    let tab: MainTab
    /// On the tab's stack (`id.depth` when nil).
    let depth: Int?
    let refresher: ScreenRefresher
    let refresh: ScreenRefresher.Refresh
    let refreshIfStale: ScreenRefresher.Refresh?
    @State private var token: ScreenToken?

    func body(content: Content) -> some View {
        content
            .onAppear {
                if let token { refresher.disappeared(token) }
                token = refresher.appeared(id, in: tab, depth: depth, refresh: refresh, refreshIfStale: refreshIfStale)
            }
            .onDisappear {
                if let token { refresher.disappeared(token) }
                token = nil
            }
    }
}

extension View {
    /// Tells the refresher while this screen of `tab` is shown (`depth` deep on the tab's stack,
    /// `id.depth` when nil), and how it reads again.
    func shownScreen(_ id: ScreenID, in tab: MainTab, depth: Int? = nil, _ refresher: ScreenRefresher, refresh: @escaping ScreenRefresher.Refresh, ifStale: ScreenRefresher.Refresh? = nil) -> some View {
        modifier(ShownScreen(id: id, tab: tab, depth: depth, refresher: refresher, refresh: refresh, refreshIfStale: ifStale))
    }
}

private struct DetailDepthKey: EnvironmentKey {
    static let defaultValue = 1
}

extension EnvironmentValues {
    /// How deep a parcel's detail opened here sits on the tab's stack: 1 from a tab's root; a delivered
    /// or cancelled page sets 2 (StatusPage), and its links hand it to the detail they push.
    var detailDepth: Int {
        get { self[DetailDepthKey.self] }
        set { self[DetailDepthKey.self] = newValue }
    }
}

/// The list's one-line note while another sample load is running (the Web's ?demo=busy note on the list), with the
/// load button's words linking to the sample page.
struct DemoBusyNote: View {
    let open: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(DemoText.busyNote)
                .font(.subheadline)
                .fixedSize(horizontal: false, vertical: true)
            Button(action: open) {
                Text(DemoText.loadLabel)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.primary)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
                    .background(Color(.systemBackground), in: RoundedRectangle(cornerRadius: 10))
                    .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color(.separator)))
            }
            .buttonStyle(.plain)
            .accessibilityHint(DemoText.busyHint)
        }
        .padding(16)
        .background(Palette.amberBackground, in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(Palette.amberBorder))
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
    }
}
