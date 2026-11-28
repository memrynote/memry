//
//  MentionTokenPromotionTests.swift
//  A body an older desktop seeded holds `((date:…))` as text. The note page
//  and the journal day page, over the real core, promote it to a date chip
//  after their own pull of the body, never on the open's walk of a copy that
//  may be stale (a peer's promotion beside it merges into two chips, #3871).
//

import Foundation
import MemryCore
import SwiftUI
import Testing
import UIKit

@testable import Memry

/// Body pulls that reach no server: each lands nothing, or fails as offline.
private final class PullingFiller: VaultFilling, @unchecked Sendable {
    let offline: Bool
    init(offline: Bool) { self.offline = offline }
    func isFirstSyncComplete() async throws -> Bool { true }
    func firstSync(
        progress: @escaping @MainActor @Sendable (SyncProgress) -> Void
    ) async throws -> FirstSyncSummary { .none }
    func pullNoteBody(noteId: String) async throws -> BodyFetchSummary {
        if offline { throw URLError(.notConnectedToInternet) }
        return BodyFetchSummary(updates: 0, baselines: 0, stopped: false)
    }
}

/// `packages/shared/src/date-mention.ts` `serializeDateMentionToken`.
private func dateToken() -> String {
    let json = #"{"anchorId":"dm_legacy","dateISO":"2099-06-15T09:00:00.000Z","hasTime":true,"dateFormat":"relative","remind":"none","timeFormat":"system"}"#
    let payload = Data(json.utf8).base64EncodedString()
        .replacingOccurrences(of: "+", with: ",")
        .replacingOccurrences(of: "/", with: ";")
        .replacingOccurrences(of: "=", with: "")
    return "((date:\(payload)))"
}

private func chips(_ runs: [InlineRun]) -> Int { runs.filter { $0.marks.contains("dateMention") }.count }
private func holdsToken(_ runs: [InlineRun]) -> Bool { runs.contains { $0.text.contains("((date:") } }

extension KeyWindowSuites {
    @Suite("Text mention tokens open as chips", .serialized)
    @MainActor
    struct MentionTokenPromotionTests {
        /// A note whose one paragraph holds a text date token, open on its page.
        private func open(offline: Bool) throws -> (NoteReadViewModel, CoreBlockEditor, String, UIWindow) {
            let vault = try TasksTestVault()
            let writer = try vault.vault.notesWriter(store: TaskTestKeychain())
            let noteId = try writer.create(title: "Agent Legacy Date", folderPath: nil)
            _ = try writer.editBlock(
                noteId: noteId,
                edit: .insertBlock(
                    kind: "paragraph", afterBlockId: nil, text: "Review on \(dateToken()). Done",
                    newBlockId: UUID().uuidString.lowercased()
                )
            )
            let reader = CoreNotesReader(vault: vault.vault, executor: .shared)
            let editor = CoreBlockEditor(vault: vault.vault, store: TaskTestKeychain(), executor: .shared)
            let model = NoteReadViewModel(
                route: NoteRoute(id: noteId), reader: reader, filler: PullingFiller(offline: offline)
            )
            let scene = try #require(UIApplication.shared.connectedScenes.first as? UIWindowScene)
            let window = UIWindow(windowScene: scene)
            window.frame = CGRect(x: 0, y: 0, width: 400, height: 800)
            window.rootViewController = UIHostingController(rootView: NoteReadView(model: model, editor: editor))
            window.makeKeyAndVisible()
            return (model, editor, noteId, window)
        }

        @Test(.timeLimit(.minutes(1)))
        func aTextDateTokenOpensAsAChipAfterThePull() async throws {
            let (model, editor, noteId, window) = try open(offline: false)
            defer { window.isHidden = true }
            func runs() -> [InlineRun] { model.blocks.flatMap(\.inline) }
            for _ in 0 ..< 300 where chips(runs()) == 0 {
                try? await Task.sleep(for: .milliseconds(20))
            }

            #expect(chips(runs()) == 1)
            #expect(!holdsToken(runs()))
            #expect(EditorSession.plainText(runs()).hasPrefix("Review on "))
            #expect(try await editor.promoteMentionTokens(noteId: noteId) == false, "a second open writes nothing")
        }

        @Test(.timeLimit(.minutes(1)))
        func anOfflineOpenLeavesTheTokenUntilAPullLands() async throws {
            let (model, _, _, window) = try open(offline: true)
            defer { window.isHidden = true }
            for _ in 0 ..< 300 where !model.blocksWalked {
                try? await Task.sleep(for: .milliseconds(20))
            }
            try? await Task.sleep(for: .milliseconds(300))

            let runs = model.blocks.flatMap(\.inline)
            #expect(model.blocksWalked)
            #expect(chips(runs) == 0, "a copy no pull refreshed was promoted")
            #expect(holdsToken(runs))
        }
    }
}

/// The journal day page reads through `JournalNoteBridge`, not `NotePageLoad`.
@MainActor
@Suite("A journal day's text mention tokens open as chips", .serialized)
struct JournalMentionTokenPromotionTests {
    private func page(_ vault: JournalTestVault, offline: Bool) -> JournalDayPageModel {
        let context = JournalVaultContext(
            reader: CoreNotesReader(vault: vault.vault, executor: CoreExecutor()),
            filler: PullingFiller(offline: offline), writer: nil, editor: nil, metadataWriter: nil,
            search: nil, noteTasks: nil
        )
        vault.store.context = context
        return JournalDayPageModel(store: vault.store, date: JournalTestVault.today, context: context)
    }

    /// The shown day's refresh, then the re-read the page makes when the
    /// store's generation moves (`JournalDayPage`).
    private func show(_ vault: JournalTestVault, offline: Bool) async throws -> (JournalDayPageModel, Int) {
        let writing = page(vault, offline: offline)
        _ = try await writing.bridge.edit(
            noteId: writing.read.route.id,
            .insertBlock(kind: "paragraph", afterBlockId: nil, text: "Due \(dateToken())", newBlockId: UUID().uuidString.lowercased())
        )
        await vault.store.loadDay(JournalTestVault.today)
        let shown = page(vault, offline: offline)
        await shown.load()
        let before = vault.store.generation
        await shown.refreshShown(store: vault.store)
        if vault.store.generation != before { await shown.read.reload() }
        return (shown, vault.store.generation - before)
    }

    @Test func aTextDateTokenOpensAsAChipAfterThePull() async throws {
        let vault = try JournalTestVault()
        let (shown, moved) = try await show(vault, offline: false)

        let runs = shown.read.blocks.flatMap(\.inline)
        #expect(moved > 0, "the page was not told to re-read")
        #expect(chips(runs) == 1)
        #expect(!holdsToken(runs))
        #expect(try await shown.bridge.promoteMentionTokens(noteId: shown.read.route.id) == false)
    }

    @Test func anOfflineOpenLeavesTheToken() async throws {
        let vault = try JournalTestVault()
        let (shown, _) = try await show(vault, offline: true)

        let runs = shown.read.blocks.flatMap(\.inline)
        #expect(chips(runs) == 0)
        #expect(holdsToken(runs))
    }
}
