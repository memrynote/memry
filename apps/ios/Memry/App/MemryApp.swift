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
        // Replaced by the router in phase C1. The scaffold exists so the target
        // builds, SwiftLint has something to lint, and the three test plans run.
        ContentUnavailableView("Memry", systemImage: "book.closed")
    }
}
