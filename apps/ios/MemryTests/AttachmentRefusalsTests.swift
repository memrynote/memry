import MemryCore
import Testing

@testable import Memry

// #5532: a queued attachment the server refuses on a later sync pass shows the
// user one alert naming the note, and an upload that lands takes it back.

@MainActor
@Suite("Attachment refusals")
struct AttachmentRefusalsTests {
    private func refused(
        _ id: String, _ refusal: AttachmentRefusal = .storageFull, status: UInt16 = 413
    ) -> QueuedAttachmentNews {
        .refused(attachmentId: id, noteId: "note-\(id)", noteTitle: "Trip", refusal: refusal, status: status)
    }

    private func alert(_ refusal: AttachmentRefusal, status: UInt16 = 413) -> AttachmentRefusalAlert {
        AttachmentRefusalAlert(
            vaultId: "v", attachmentId: "a", noteId: "n", noteTitle: "Trip", refusal: refusal, status: status
        )
    }

    @Test func a_refusal_is_shown_once_and_a_later_pass_without_news_shows_nothing() {
        let refusals = AttachmentRefusals()
        refusals.absorb([refused("a")], vaultId: "v")
        let shown = refusals.shown(in: "v")
        #expect(shown?.noteId == "note-a")
        #expect(shown?.refusal == .storageFull)

        refusals.dismiss("a")
        refusals.absorb([], vaultId: "v")
        #expect(refusals.shown(in: "v") == nil)
    }

    /// The alert's button and its `isPresented` setter both dismiss on one
    /// tap: the second must not take the next refusal, which the core
    /// already counts as told.
    @Test func one_tap_dismissing_twice_keeps_the_next_refusal() {
        let refusals = AttachmentRefusals()
        refusals.absorb([refused("a"), refused("b")], vaultId: "v")
        refusals.dismiss("a")
        refusals.dismiss("a")
        #expect(refusals.shown(in: "v")?.id == "b")
    }

    @Test func a_refusal_shows_only_in_its_own_vault() {
        let refusals = AttachmentRefusals()
        refusals.absorb([refused("a")], vaultId: "v1")
        #expect(refusals.shown(in: "v2") == nil)
        #expect(refusals.shown(in: "v1")?.id == "a")
    }

    @Test func the_same_attachment_refused_again_is_one_alert() {
        let refusals = AttachmentRefusals()
        refusals.absorb([refused("a"), refused("a", .notAllowed)], vaultId: "v")
        #expect(refusals.pending.map(\.refusal) == [.notAllowed])
    }

    @Test func an_upload_that_lands_takes_its_alert_back() {
        let refusals = AttachmentRefusals()
        refusals.absorb([refused("a"), refused("b")], vaultId: "v")
        refusals.absorb([.uploaded(attachmentId: "a", noteId: "note-a")], vaultId: "v")
        #expect(refusals.pending.map(\.id) == ["b"])
        refusals.absorb([.uploaded(attachmentId: "b", noteId: "note-b")], vaultId: "v")
        #expect(refusals.shown(in: "v") == nil)
    }

    @Test func the_copy_names_the_note_and_the_way_out() {
        #expect(AttachmentRefusalCopy.title(alert(.storageFull)) == "A file in \u{201C}Trip\u{201D} could not sync")
        #expect(AttachmentRefusalCopy.message(alert(.storageFull)).contains("free up space"))
        #expect(alert(.storageFull).offersFreeUpSpace)
        let untitled = AttachmentRefusalAlert(
            vaultId: "v", attachmentId: "a", noteId: "n", noteTitle: "", refusal: .rejected, status: 400
        )
        #expect(AttachmentRefusalCopy.title(untitled).contains("\u{201C}Untitled\u{201D}"))
    }

    /// A per-file limit, a lapsed plan and a file this device could not frame
    /// are no full storage: none says to free up space or offers it.
    @Test func only_a_full_quota_says_to_free_up_space() {
        for other in [alert(.tooLarge), alert(.notAllowed, status: 403), alert(.rejected, status: 400),
                      alert(.rejected, status: 402), alert(.rejected, status: 0)] {
            #expect(!AttachmentRefusalCopy.message(other).contains("free up space"))
            #expect(!other.offersFreeUpSpace)
        }
        #expect(AttachmentRefusalCopy.message(alert(.tooLarge)).contains("too large"))
        #expect(AttachmentRefusalCopy.message(alert(.rejected, status: 402)).contains("renew"))
        let local = AttachmentRefusalCopy.message(alert(.rejected, status: 0))
        #expect(!local.contains("server"))
        #expect(local.contains("this \(ThisDevice.noun)"))
    }
}
