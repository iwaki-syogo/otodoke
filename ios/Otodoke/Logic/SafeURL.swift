// TDD-STUB(task 5): type stub written by the test architect so the test target compiles.
// Keep the names and shapes; replace the bodies with the implementation and delete this marker line.
// Port of src/lib/safe-url.ts.

import Foundation

enum SafeURL {
    /// True only for an absolute https: URL with a host (as the Web's `new URL` reads it).
    static func isHttpsUrl(_ raw: String?) -> Bool { false }
}
