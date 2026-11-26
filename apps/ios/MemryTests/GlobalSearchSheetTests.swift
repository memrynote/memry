import MemryCore
import SwiftUI
import Synchronization
import Testing
import UIKit

@testable import Memry

// VERIFY-4419 #2: the open search sheet follows the index owner. A reindex
// finishing while the sheet shows a query runs that query again, so a sync
// landing under an open sheet reaches its results. This hosts the real sheet
// and types through its real search bar.

extension KeyWindowSuites {
    @MainActor
    @Suite("Global search sheet", .serialized, .timeLimit(.minutes(1)))
    struct GlobalSearchSheetTests {
        /// Answers nothing and counts the queries it was asked.
        private final class CountedSearch: VaultSearching, @unchecked Sendable {
            let queries = Mutex(0)
            let changes = Changes()

            func search(query: String, filter: SearchFilter?, limit: UInt32) async throws -> SearchGroups {
                queries.withLock { $0 += 1 }
                changes.changed()
                return SearchGroups(notes: [], journals: [], tasks: [], inbox: [])
            }
            func semanticModelLoaded() async -> Bool { false }
            func reindex() async throws {}
            func backlinks(noteId: String, order: BacklinkOrder) async throws -> [Backlink] { [] }
            func linksTo(targetId: String, order: BacklinkOrder) async throws -> [BacklinkRow] { [] }
            func unlinkedMentions(targetId: String) async throws -> [UnlinkedMention] { [] }
        }

        private func searchBar(in view: UIView) -> UISearchBar? {
            if let bar = view as? UISearchBar { return bar }
            return view.subviews.lazy.compactMap { searchBar(in: $0) }.first
        }

        @Test("a reindex under the open sheet runs its query again")
        func aReindexRerunsTheSheetsQuery() async throws {
            let search = CountedSearch()
            let index = VaultSearchIndex(search: search, debounce: .zero)
            let scratch = try TasksTestVault()
            let browse = VaultBrowseViewModel(
                reader: CoreNotesReader(vault: scratch.vault, executor: .shared), search: search
            )
            // A scene's window: a bare `UIWindow(frame:)` draws no navigation bar.
            let scene = try #require(UIApplication.shared.connectedScenes.first as? UIWindowScene)
            let window = UIWindow(windowScene: scene)
            window.rootViewController = UIHostingController(
                rootView: GlobalSearchSheet(
                    presentation: .sheet, browse: browse, openNote: { _ in }, openTask: { _ in }, openInboxItem: { _ in }, openJournalDay: { _ in }
                )
                .environment(\.vaultSearchIndex, index)
            )
            window.makeKeyAndVisible()
            defer { window.isHidden = true }

            var bar: UISearchBar?
            // Generous: SwiftUI lays the bar out on the main actor, which a full
            // parallel Unit run keeps busy for seconds (#5484).
            try await wait(30) { bar = searchBar(in: window); return bar != nil }
            let field = try #require(bar)
            field.text = "dune"
            field.delegate?.searchBar?(field, textDidChange: "dune")
            await search.changes.until { search.queries.withLock { $0 } >= 1 }
            #expect(search.queries.withLock { $0 } == 1, "the typed query never ran")

            index.schedule()
            await search.changes.until { search.queries.withLock { $0 } >= 2 }

            #expect(search.queries.withLock { $0 } == 2, "the reindex never reached the open sheet")
        }
    }
}
