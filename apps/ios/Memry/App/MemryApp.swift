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
    /// B0 spike S3 only (`Memry/Spikes/`), reached with `--spike-s3`. The
    /// scaffold is what the app shows otherwise, unchanged.
    private let spikeS3 = ProcessInfo.processInfo.arguments.contains("--spike-s3")

    var body: some View {
        if spikeS3 {
            SpikeS3View()
        } else {
            // Replaced by the router in phase C1. The scaffold exists so the target
            // builds, SwiftLint has something to lint, and the three test plans run.
            ContentUnavailableView("Memry", systemImage: "book.closed")
        }
    }
}
