// TDD-STUB(task 3): type stub written by the test architect so the test target compiles.
// Keep the names and shapes; replace the bodies with the implementation and delete this marker line.
// RootView (the SwiftUI view) goes in this file too; it shows the screen RootScreen.of(...) picks.

import Foundation

enum RootScreen: Equatable, Sendable {
    case loading
    case login
    case main

    static func of(_ state: AuthService.State) -> RootScreen { .loading }
}
