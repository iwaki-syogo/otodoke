// [N-r3-1] Pull to refresh whose read runs to the end. SwiftUI cancels a .refreshable action's task when a
// screen is pushed over it (seen on the simulator: RefreshToTheEndTests), and nothing reads again when
// the screen comes back (a NavigationStack's .task does not run again on a pop). A read cut off that way
// is dropped (the calendar's move then stays on the way, its buttons disabled) or comes back as a
// failure (the delivered and cancelled pages say 読み込めませんでした). The read runs in its own task, so
// the push does not cut it off; the spinner still ends when the read does.

import SwiftUI

extension View {
    /// `.refreshable`, with `action` run in its own task (not cancelled with the pull's).
    func refreshableToTheEnd(_ action: @escaping @Sendable () async -> Void) -> some View {
        refreshable {
            await Task { await action() }.value
        }
    }
}
