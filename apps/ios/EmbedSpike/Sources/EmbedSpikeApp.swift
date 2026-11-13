import SwiftUI

@main
struct EmbedSpikeApp: App {
    var body: some Scene {
        WindowGroup { BenchView() }
    }
}

struct BenchView: View {
    @State private var status = "starting"

    var body: some View {
        Text(status)
            .padding()
            .task { await Bench.run { status = $0 } }
    }
}
