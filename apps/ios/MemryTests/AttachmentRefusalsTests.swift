import MemryCore
import Testing

@testable import Memry

// #5532: a queued attachment the server refuses on a later sync pass shows the
// user one alert naming the note, and an upload that lands takes it back.

@MainActor
@Suite("Attachment refusals")
struct AttachmentRefusalsTests {
    private func refused(_ id: String, _ refusal: AttachmentRefusal = .storageFull) -> QueuedAttachmentNews {
        .refused(attachmentId: id, noteId: "note-\(id)", noteTitle: "Trip", refusal: refusal, status: 413)
    }

    @Test func a_refusal_is_shown_once_and_a_later_pass_without_news_shows_nothing() {
        let refusals = AttachmentRefusals()
        refusals.absorb([refused("a")])
        let shown = refusals.shown
        #expect(shown?.noteId == "note-a")
        #expect(shown?.refusal == .storageFull)

        refusals.dismiss()
        refusals.absorb([])
        #expect(refusals.shown == nil)
    }

    @Test func the_same_attachment_refused_again_is_one_alert() {
        let refusals = AttachmentRefusals()
        refusals.absorb([refused("a"), refused("a", .notAllowed)])
        #expect(refusals.pending.map(\.refusal) == [.notAllowed])
    }

    @Test func an_upload_that_lands_takes_its_alert_back() {
        let refusals = AttachmentRefusals()
        refusals.absorb([refused("a"), refused("b")])
        refusals.absorb([.uploaded(attachmentId: "a", noteId: "note-a")])
        #expect(refusals.pending.map(\.id) == ["b"])
        refusals.absorb([.uploaded(attachmentId: "b", noteId: "note-b")])
        #expect(refusals.shown == nil)
    }

    @Test func the_copy_names_the_note_and_the_way_out() {
        let full = AttachmentRefusalAlert(attachmentId: "a", noteId: "n", noteTitle: "Trip", refusal: .storageFull)
        #expect(AttachmentRefusalCopy.title(full) == "A file in \u{201C}Trip\u{201D} could not sync")
        #expect(AttachmentRefusalCopy.message(.storageFull).contains("free up space"))
        #expect(!AttachmentRefusalCopy.message(.rejected).contains("free up space"))
        let untitled = AttachmentRefusalAlert(attachmentId: "a", noteId: "n", noteTitle: "", refusal: .rejected)
        #expect(AttachmentRefusalCopy.title(untitled).contains("\u{201C}Untitled\u{201D}"))
    }
}
