import Foundation

extension URL {
    /// Runs `body` with access to a url a `fileImporter` returned, and gives
    /// the access back even when `body` throws.
    func withSecurityScope<T>(_ body: () throws -> T) rethrows -> T {
        let scoped = startAccessingSecurityScopedResource()
        defer { if scoped { stopAccessingSecurityScopedResource() } }
        return try body()
    }
}
