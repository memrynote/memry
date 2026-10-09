import Foundation
import MemryCore
import SwiftUI
import Testing
import UIKit

@testable import Memry

// The notes list's writes ask for a sync pass through `requestVaultSync`
// (#2893). On a cold launch that action is nil until the tasks store exists,
// which is after Notes, the first tab, has appeared. These host the real view
// and flip the environment the way the vault scope does.

@MainActor
@Suite("Notes sync wiring")
struct NotesSyncWiringTests {
    private final class EmptyReader: NotesReading, @unchecked Sendable {
        func folders() async throws -> [FolderSummary] { [] }
        func list() async throws -> [NoteSummary] { [] }
        func read(id: String) async throws -> NoteDetail? { nil }
    }

    @Observable
    final class Scope {
        var request: (@MainActor () -> Void)?
    }

    private struct Host: View {
        let scope: Scope
        let model: VaultBrowseViewModel
        var body: some View {
            NotesListView(model: model).environment(\.requestVaultSync, scope.request)
        }
    }

    @Test("a sync request that arrives after the list appeared still reaches its writes")
    func lateSyncRequestReachesTheModel() async throws {
        let model = VaultBrowseViewModel(reader: EmptyReader())
        let scope = Scope()
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 400, height: 800))
        window.rootViewController = UIHostingController(rootView: Host(scope: scope, model: model))
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        try await Task.sleep(for: .milliseconds(300))
        #expect(model.requestSync == nil)

        var requests = 0
        scope.request = { requests += 1 }
        for _ in 0 ..< 20 where model.requestSync == nil {
            try await Task.sleep(for: .milliseconds(50))
        }

        model.requestSync?()
        #expect(requests == 1, "the list kept the nil it saw at launch")
    }
}
