import Testing

@testable import Memry

// Placeholder so the Unit plan has a test to run before phase B lands real ones.
@Suite("Scaffold")
struct ScaffoldTests {
    @MainActor
    @Test("the app target links and the root view builds")
    func rootViewBuilds() {
        _ = RootView().body
    }
}
