import os
import UIKit

/// Keeps the app running until an HTTP exchange it started is answered (#4156).
///
/// The server rotates the refresh token on every `POST /auth/refresh` and
/// treats a retired token presented more than ten seconds later as reuse,
/// which revokes every token the device holds (chapter 02 §2.9). When iOS
/// suspends the app between the server committing a rotation and the response
/// arriving, the keychain keeps the retired token and the next refresh signs
/// the user out. A background task lets the exchange finish, and the core
/// store the new pair, before the app is suspended.
struct ExchangeHold: Sendable {
    /// Begins a hold and returns the call that ends it.
    let begin: @Sendable () -> @Sendable () -> Void

    static let none = ExchangeHold { {} }

    /// `UIApplication.shared` is main-actor state, so the hold is built on the
    /// main actor and crosses into the core executor as a value.
    /// `beginBackgroundTask` and `endBackgroundTask` are nonisolated, so the
    /// transport calls them from whatever thread the core sends on.
    @MainActor
    static func application() -> ExchangeHold {
        let application = UIApplication.shared
        return ExchangeHold {
            let held = OSAllocatedUnfairLock(initialState: UIBackgroundTaskIdentifier.invalid)
            // Ends the task once, whichever of the answer or expiry comes first.
            let end: @Sendable () -> Void = {
                let id = held.withLock { id in
                    defer { id = .invalid }
                    return id
                }
                if id != .invalid { application.endBackgroundTask(id) }
            }
            let id = application.beginBackgroundTask(withName: "sync-exchange", expirationHandler: end)
            held.withLock { $0 = id }
            return end
        }
    }
}
