import SwiftUI

@main
struct MemryApp: App {
    var body: some Scene {
        WindowGroup {
            RootView()
        }
    }
}

struct RootView: View {
    var body: some View {
        // T147. The scaffold is gone, and so is the `--spike-s3` branch that
        // stood beside it: this is the first build in which the app actually
        // reaches the core. `AuthRootView` owns the composition — the event
        // hub, the executor, the real `Keychain` and the real
        // `URLSessionTransport` behind one `AuthSession`.
        //
        // The router that puts unlock, vaults and notes after sign-in is still
        // phase C1's, and **T158 owns this root's event consumer**
        // (`CoreEvents.consume()`, spec-defect 92) along with §7.15's runtime
        // obligations.
        AuthRootView()
    }
}
