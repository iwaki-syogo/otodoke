import Foundation
import SwiftUI
import Testing
import UIKit
@testable import Otodoke

// [N-r3-1] A pull to refresh while a screen is pushed over it. The refresh is started as the pull gesture
// starts it (the UIRefreshControl's valueChanged), so SwiftUI owns the action's task. SwiftUI cancels a
// plain .refreshable's task on the push (the negative control: why the app does not use it), and nothing
// runs the stack's .task again on the pop. refreshableToTheEnd runs the action to the end.

@MainActor
@Observable
final class RefreshProbeNav {
    var path: [Int] = []
}

final class RefreshProbeLog: @unchecked Sendable {
    private let lock = NSLock()
    private var lines: [String] = []
    private var released = false
    func note(_ s: String) { lock.withLock { lines.append(s) } }
    var all: [String] { lock.withLock { lines } }
    func release() { lock.withLock { released = true } }
    var isReleased: Bool { lock.withLock { released } }
}

private struct RefreshProbeView: View {
    @Bindable var nav: RefreshProbeNav
    let log: RefreshProbeLog
    let toTheEnd: Bool

    var body: some View {
        NavigationStack(path: $nav.path) {
            root.navigationDestination(for: Int.self) { n in Text("detail \(n)") }
        }
        .task { log.note("stack task") }
    }

    @ViewBuilder
    private var root: some View {
        let scroll = ScrollView { VStack { Text("root"); Spacer(minLength: 400) } }
        if toTheEnd {
            scroll.refreshableToTheEnd { await Self.read(log) }
        } else {
            scroll.refreshable { await Self.read(log) }
        }
    }

    /// Waits until released (at most 10 s), or until cut off.
    private static func read(_ log: RefreshProbeLog) async {
        log.note("started")
        await withTaskCancellationHandler {
            for _ in 0..<200 {
                if Task.isCancelled || log.isReleased { break }
                try? await Task.sleep(for: .milliseconds(50))
            }
        } onCancel: {
            log.note("cancelled")
        }
        log.note(Task.isCancelled ? "ended cut off" : "ended")
    }
}

@Suite("N-r3-1: a pull to refresh while a screen is pushed", .serialized)
@MainActor
struct RefreshToTheEndTests {
    private func find<T: UIView>(_ type: T.Type, in view: UIView) -> T? {
        if let v = view as? T { return v }
        for s in view.subviews { if let f = find(type, in: s) { return f } }
        return nil
    }

    private func until(_ seconds: Double = 5, _ condition: () -> Bool) async -> Bool {
        for _ in 0..<Int(seconds * 20) {
            if condition() { return true }
            try? await Task.sleep(for: .milliseconds(50))
        }
        return condition()
    }

    /// Pull, push a screen, pop, then let the read end. The log of the read.
    private func pullPushPop(toTheEnd: Bool) async throws -> [String] {
        let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        for _ in 0..<100 where scene.activationState != .foregroundActive {
            try await Task.sleep(for: .milliseconds(100))
        }
        let nav = RefreshProbeNav()
        let log = RefreshProbeLog()
        let window = UIWindow(windowScene: scene)
        window.frame = scene.coordinateSpace.bounds
        window.windowLevel = .alert + 1
        window.rootViewController = UIHostingController(rootView: RefreshProbeView(nav: nav, log: log, toTheEnd: toTheEnd))
        window.makeKeyAndVisible()
        defer {
            log.release()
            window.isHidden = true
            window.rootViewController = nil
        }
        #expect(await until { find(UIRefreshControl.self, in: window) != nil }, "no UIRefreshControl")
        let control = try #require(find(UIRefreshControl.self, in: window))
        control.beginRefreshing()
        control.sendActions(for: .valueChanged)
        #expect(await until { log.all.contains("started") }, "the pull did not start the action")

        nav.path = [1]
        // Give SwiftUI time to cut the action off (it does so at once for a plain .refreshable).
        _ = await until(1.5) { log.all.contains("cancelled") }
        nav.path = []
        try await Task.sleep(for: .milliseconds(500))
        log.release()
        _ = await until { log.all.contains { $0.hasPrefix("ended") } }
        return log.all
    }

    /// Negative control: SwiftUI cuts a plain .refreshable off on the push, and the stack's .task does
    /// not run again on the pop (so nothing reads again).
    @Test func aPlainRefreshableIsCutOffByThePush() async throws {
        let log = try await pullPushPop(toTheEnd: false)
        #expect(log.contains("cancelled"), "\(log)")
        #expect(log.contains("ended cut off"), "\(log)")
        #expect(log.filter { $0 == "stack task" }.count == 1, "\(log)")
    }

    @Test func refreshableToTheEndRunsTheReadToTheEnd() async throws {
        let log = try await pullPushPop(toTheEnd: true)
        #expect(!log.contains("cancelled"), "\(log)")
        #expect(log.contains("ended"), "\(log)")
        #expect(!log.contains("ended cut off"), "\(log)")
    }
}
