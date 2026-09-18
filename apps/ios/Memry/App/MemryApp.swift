import Inject
import SwiftUI

@main
struct MemryApp: App {
    var body: some Scene {
        WindowGroup {
            RootView()
        }
    }
}

/// The app root, and **the hub's owner** (T158, spec-defect 92).
///
/// The hub moved here from `AuthStartup` for one reason: the consumer belongs
/// to whatever outlives every screen, and `AuthStartup` is a feature object
/// that documented in a comment that it must not take the stream. Ownership
/// says it instead — `ShellState` holds the `CoreEvents` privately and hands
/// `AuthStartup` an emitter, so no other call site *can* reach `consume()`.
struct RootView: View {
    @Environment(\.scenePhase) private var scenePhase
    @State private var shell = ShellState()
    // Hot reload (InjectionNext + Inject). No-op in release builds.
    // ponytail: root-only — a save re-evaluates this body, so the whole tree
    // picks up injected code. Add `@ObserveInjection`/`.enableInjection()` to
    // a specific view only if it has state that must survive the reload.
    @ObserveInjection private var inject

    var body: some View {
        // T147. The scaffold is gone, and so is the `--spike-s3` branch that
        // stood beside it: this is the first build in which the app actually
        // reaches the core. `AuthRootView` owns the composition — the
        // executor, the real `Keychain` and the real `URLSessionTransport`
        // behind one `AuthSession` — over the emitter handed down from here.
        //
        // The router that puts unlock, vaults and notes after sign-in is still
        // phase C1's.
        AuthRootView(emitter: shell.emitter)
            // Above the content rather than over it: a notice that covered the
            // unlock screen would hide the thing it is asking the user to
            // come back to.
            .safeAreaInset(edge: .top) {
                if let notice = shell.secureStoreNotice {
                    ErrorNotice(error: notice, code: nil)
                        .padding(.horizontal, Tokens.Space.inset)
                        .padding(.top, Tokens.Space.small)
                }
            }
            .calmAnimation(.normal, value: shell.secureStore)
            // **The single `CoreEvents.consume()` call site.** `.task` rather
            // than a `Task {}`: SwiftUI cancels it when this view goes away,
            // so the loop cannot outlive its owner and there is nothing to
            // leak.
            .task { await shell.consume() }
            .onChange(of: scenePhase, initial: true) { _, phase in
                shell.scenePhaseChanged(to: phase)
            }
            .enableInjection()
    }
}
