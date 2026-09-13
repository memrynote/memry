import MemryCore
import Observation
import SwiftUI

// T147. What the app shows before anything is signed in, and the runtime half
// of the composition root.
//
// **This is where the shell first reaches the core.** Everything in
// `Memry/Core` and `Memry/Seams` had zero production call sites before this
// file: `CoreExecutor`, `CoreEvents`, `ErrorMapping`, `Log`, `Keychain` and
// `URLSessionTransport` were implemented, tested behind substituted platforms,
// and never constructed. They are constructed here.

/// Builds the session once, and says so out loud when it cannot.
@MainActor
@Observable
final class AuthStartup {
    enum Phase {
        case starting
        case ready(SignInViewModel)
        /// The app cannot reach the core. **Not** a tenth auth state: the auth
        /// machine has no instance yet, which is a different thing from being
        /// signed out.
        case unavailable(UserFacingError)
    }

    private(set) var phase: Phase = .starting

    /// The process's one event hub.
    ///
    /// **Its stream is deliberately not taken here.** `CoreEvents.consume()`
    /// vends the stream once and returns `nil` on every later call, and the
    /// single consumer is **T158's** (spec-defect 92) — along with §7.15's
    /// runtime obligations on `purged_documents` and `advanced_documents`, and
    /// the `snapshot_is_due` poll (spec-defect 100), which are the app root's
    /// and which T158 owns. The hub exists now only because `Keychain` and
    /// `URLSessionTransport` cannot be constructed without an emitter.
    private let events = CoreEvents()
    private let executor = CoreExecutor.shared

    func begin() async {
        guard case .starting = phase else { return }
        switch SyncEnvironment.current {
        case let .misconfigured(fault):
            let mapped = fault.userFacing
            // `fault` is the one level on by default on a user's device, which
            // is where a build shipped without its server setting is found.
            Log.app.fault("this build has no usable sync environment", .code(mapped.code))
            phase = .unavailable(mapped)
        case let .resolved(environment):
            await start(in: environment)
        }
    }

    private func start(in environment: SyncEnvironment) async {
        do {
            // `UIDevice` is main-actor work, so the descriptor is built here
            // and crosses into the executor as a value.
            let descriptor = try AuthComposition.device()
            let emitter = events.emitter
            let session = try await executor.run {
                try AuthComposition.makeSession(
                    environment: environment,
                    device: descriptor,
                    emitter: emitter
                )
            }
            // `state()` is synchronous and blocking, so it goes through the
            // executor too — and it is read before the view model exists, so
            // there is no instant at which a state nobody reported is on screen.
            let state = try await executor.run { session.state() }
            // No URL, no address, no token: `Log` accepts a `StaticString` and
            // a number and there is nowhere to put one.
            Log.app.notice("auth session constructed")
            phase = .ready(SignInViewModel(session: session, executor: executor, state: state))
        } catch {
            let mapped = ErrorMapping.userFacing(error)
            Log.app.fault("the auth session could not be constructed", .code(mapped.code))
            phase = .unavailable(mapped)
        }
    }
}

struct AuthRootView: View {
    @State private var startup = AuthStartup()

    var body: some View {
        Group {
            switch startup.phase {
            case .starting:
                ProgressView()
                    .controlSize(.large)
            case let .ready(model):
                SignInView(model: model)
            case let .unavailable(error):
                AuthUnavailableView(error: error)
            }
        }
        .task { await startup.begin() }
    }
}

/// The screen for a build that cannot reach a server at all.
///
/// A system `ContentUnavailableView` rather than a hand-built one: dynamic
/// type, RTL mirroring and the accessibility grouping come from the platform,
/// and there is nothing here worth reimplementing to own.
private struct AuthUnavailableView: View {
    let error: UserFacingError

    var body: some View {
        ContentUnavailableView {
            Label(error.title, systemImage: "exclamationmark.triangle")
        } description: {
            if let guidance = error.guidance {
                Text(guidance)
            }
        }
    }
}
