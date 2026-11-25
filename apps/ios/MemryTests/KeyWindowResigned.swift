import UIKit

/// Whether `window` stopped being the key window while watched. Suites run
/// in parallel in one process, and a window another suite makes key takes
/// the caret mid-test: a run it interrupted proves nothing either way, so a
/// test that types into the caret runs again (#5780).
@MainActor
final class Resigned {
    private(set) var happened = false
    private var observer: NSObjectProtocol?

    init(_ window: UIWindow) {
        observer = NotificationCenter.default.addObserver(
            forName: UIWindow.didResignKeyNotification, object: window, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.happened = true }
        }
    }

    func stop() {
        observer.map(NotificationCenter.default.removeObserver)
        observer = nil
    }
}

extension Resigned {
    /// Runs `scenario` until no other suite made the window it watches key
    /// meanwhile, at most ten times, and returns what the last run saw.
    /// `scenario` makes its window and hands it to `watch` before it types;
    /// the window is hidden when the run ends. The last run counts whether
    /// interrupted or not, so a test still asserts every time (#5780).
    static func uninterrupted<T>(
        _ scenario: @MainActor (_ watch: @MainActor (UIWindow) -> Void) async throws -> T
    ) async throws -> T {
        var attempt = 0
        while true {
            attempt += 1
            var watched: (window: UIWindow, resigned: Resigned)?
            let seen = try await scenario { watched = ($0, Resigned($0)) }
            watched?.resigned.stop()
            watched?.window.isHidden = true
            if watched?.resigned.happened != true || attempt == 10 { return seen }
            try await Task.sleep(for: .milliseconds(200 * attempt))
        }
    }
}
