import Foundation

/// Waits until `condition` holds, or `timeout` seconds pass. The caller's
/// `#expect` after it reports a condition that never held.
@MainActor
func wait(_ timeout: TimeInterval = 3, until condition: () -> Bool) async throws {
    let deadline = Date().addingTimeInterval(timeout)
    while !condition(), Date() < deadline { try await Task.sleep(for: .milliseconds(20)) }
}
