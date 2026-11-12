import Foundation
import MemryCore
import Synchronization
import Testing

@testable import Memry

// #4158. Whether the free path's vault is empty decides if signing in adds it
// to the account, so the probe runs over the real core: a real vault directory,
// a real write, and the production session with no network.

@MainActor
@Suite("Local vault content", .serialized)
final class LocalVaultContentTests {
    private let hub = CoreEvents()
    private let root: URL
    private let files: VaultFiles
    private let executor = CoreExecutor(label: "local-vault-content-tests")
    private let vaultId = "local-0123456789abcdef"

    init() {
        root = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            .appendingPathComponent("local-content-\(UUID().uuidString)", isDirectory: true)
        files = VaultFiles(emitter: hub.emitter, root: root)
    }

    deinit {
        try? FileManager.default.removeItem(at: root)
    }

    private func content() throws -> LocalVaultContent {
        let configuration = URLSessionTransport.defaultConfiguration()
        configuration.protocolClasses = [NoRequestURLProtocol.self]
        let session = try AuthComposition.makeSession(
            environment: .staging,
            device: AuthComposition.device(appVersion: "0.1.0+4158"),
            emitter: hub.emitter,
            transportConfiguration: configuration,
            keychainItems: RecordingKeychainItems()
        )
        return LocalVaultContent(files: files, session: session, executor: executor)
    }

    @Test("a vault nobody wrote to is empty, and one note makes it not")
    func emptyUntilWritten() async throws {
        NoRequestURLProtocol.reset()
        let content = try content()
        let vault = try await CoreVaultOpener(files: files, executor: executor).open(vaultId)

        #expect(try await content.isEmpty(vaultId))

        _ = try vault.notesWriter(store: TaskTestKeychain()).create(title: "SHIP-4158-note", folderPath: nil)

        #expect(try await !content.isEmpty(vaultId))
        #expect(NoRequestURLProtocol.seen.withLock { $0 }.isEmpty)
    }
}
