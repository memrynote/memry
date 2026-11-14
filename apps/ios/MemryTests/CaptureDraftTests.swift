import Foundation
import MemryCore
import Testing

@testable import Memry

// #4482. The capture draft belongs to the vault's `QuickCapture`, not to the
// sheet: an iPad picker closes on a size-class change, and the text typed in
// it must be there when it opens again. These drive the real journal capture
// over a scratch vault.

@MainActor
@Suite("Capture draft", .serialized)
struct CaptureDraftTests {
    private func makeCapture() throws -> (QuickCapture, Journal) {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("memry-capture-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let vault = try Vault.open(vaultId: "vault-capture-test", directory: directory.path)
        let keychain = TaskTestKeychain()
        let capture = QuickCapture(vault: vault, secureStore: keychain, tasks: nil, inbox: nil, browse: nil)
        return (capture, try vault.journal(store: keychain))
    }

    private func save(_ draft: CaptureDraft, _ capture: QuickCapture) async -> CaptureReceipt? {
        await draft.save(as: .journal) { await capture.capture($0, as: $1) }
    }

    @Test func a_closed_sheet_keeps_the_draft_and_a_save_clears_it() async throws {
        let (capture, journal) = try makeCapture()
        // Typed into a sheet that then closes without saving.
        capture.journalDraft.text = "half a thought"
        // The reopened sheet reads the same draft.
        #expect(capture.journalDraft.text == "half a thought")
        #expect(capture.homeDraft.text.isEmpty, "Home keeps its own draft")

        let receipt = await save(capture.journalDraft, capture)
        #expect(receipt?.kind == .journal)
        #expect(capture.journalDraft.text.isEmpty)
        #expect(!capture.journalDraft.saving)
        let entry = try #require(try journal.entryId(date: capture.today))
        #expect(!entry.isEmpty)
    }

    @Test func text_typed_while_saving_survives_and_a_second_save_is_refused() async throws {
        let (capture, _) = try makeCapture()
        let draft = capture.journalDraft
        draft.text = "first"
        var calls = 0
        let receipt = await draft.save(as: .journal) { text, kind in
            calls += 1
            // A reopened sheet tries to send again, and the user keeps typing.
            #expect(await draft.save(as: kind) { _, _ in nil } == nil)
            draft.text = "first, and more"
            return await capture.capture(text, as: kind)
        }
        #expect(receipt != nil)
        #expect(calls == 1)
        #expect(draft.text == "first, and more", "a newer draft is not cleared")
    }

    @Test func a_failed_save_keeps_the_draft() async {
        let draft = CaptureDraft()
        draft.text = "keep me"
        #expect(await draft.save(as: .inbox) { _, _ in nil } == nil)
        #expect(draft.text == "keep me")
        #expect(draft.failed)
        #expect(draft.canSave)
    }
}
