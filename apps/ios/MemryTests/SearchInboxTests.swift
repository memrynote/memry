import Foundation
import MemryCore
import Testing

@testable import Memry

// The search sheet's Inbox section (#4320), through a real vault, the core's
// index and the sheet's model. The ranking and the index rules are pinned in
// Rust (`domain_search_inbox.rs`); this pins that a capture written on this
// iPhone reaches the model's inbox hits, and leaves them when it is deleted.

@MainActor
@Suite("Search inbox")
struct SearchInboxTests {
    @Test func an_archived_capture_is_an_inbox_hit_until_it_is_deleted() async throws {
        let scratch = try InboxTestVault()
        let captured = try scratch.inbox.captureText(
            content: "[agent] a note about zephyrinboxtest", title: "Article about managers",
            captureSource: nil, force: false
        )
        let id = captured.item.id
        _ = try scratch.inbox.archive(id: id)
        let search = try CoreVaultSearch(vault: scratch.vault, executor: .shared)
        let model = VaultSearchViewModel(search: search, debounce: .zero)

        try await search.reindex()
        model.run("zephyrinboxtest")
        await model.settle()

        #expect(model.inboxHits.map(\.id) == [id])
        #expect(model.inboxHits.first?.kind == "inbox")
        #expect(model.inboxHits.first?.snippet.contains { $0.highlighted && $0.text == "zephyrinboxtest" } == true)
        #expect(model.phase == .results([]))

        try scratch.inbox.deletePermanently(id: id)
        try await search.reindex()
        model.run("zephyrinboxtest")
        await model.settle()

        #expect(model.inboxHits.isEmpty)
    }

    @Test func an_inbox_hit_names_its_capture() {
        let hit = SearchResult(
            id: "c1", title: "", kind: "inbox", journalDate: nil, emoji: nil, folderPath: nil,
            score: -1, snippet: [SnippetSegment(text: "a read", highlighted: false)],
            matchKind: .body, matchedName: nil
        )
        let text = SearchRowText(hit: hit)

        #expect(text.title == InboxCopy.untitled)
        #expect(text.caption == nil)
        #expect(text.accessibilityLabel == "Inbox, Untitled, a read")
    }
}
