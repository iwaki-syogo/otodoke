import Foundation
import ObjectiveC

/// A UserDefaults suite owned by one test, removed when the test lets go of it.
final class TestDefaults: @unchecked Sendable {
    let name = "OtodokeTests-\(UUID().uuidString)"
    let defaults: UserDefaults

    init() { defaults = UserDefaults(suiteName: name)! }
    deinit { defaults.removePersistentDomain(forName: name) }

    /// A new suite that removes itself once the returned object (and so the service holding it) is gone.
    static func fresh() -> UserDefaults {
        let name = "OtodokeTests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        objc_setAssociatedObject(defaults, remover, DomainRemover(name: name), .OBJC_ASSOCIATION_RETAIN)
        return defaults
    }

    private nonisolated(unsafe) static let remover = UnsafeRawPointer(UnsafeMutableRawPointer.allocate(byteCount: 1, alignment: 1))
}

private final class DomainRemover {
    let name: String
    init(name: String) { self.name = name }
    deinit { UserDefaults.standard.removePersistentDomain(forName: name) }
}
