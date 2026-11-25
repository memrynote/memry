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
