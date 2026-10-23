import MemryCore
import Foundation
import Testing

@testable import Memry

// #3477, D18. The Readwise status screen's words and the divider's markers.
@MainActor
struct ReadwiseTests {
    private func block(_ kind: String = "paragraph", inline: [InlineRun]) -> Block {
        Block(id: "b1", kind: kind, depth: 0, props: [], inline: inline)
    }

    private func comment(_ source: String) -> InlineRun {
        InlineRun(text: "", marks: ["htmlComment"], markAttrs: ["htmlComment.source": source], target: nil)
    }

    @Test func the_four_markers_read_as_their_labels() {
        let cases: [(String, String)] = [
            ("<!-- readwise:start -->", "Readwise · syncs automatically"),
            ("<!-- readwise:end -->", "End of Readwise section"),
            ("<!-- readwise-day:start -->", "Readwise · today's highlights"),
            ("<!--readwise-day:end-->", "End of Readwise"),
            ("<!-- readwise:start id=42 -->", "Readwise · syncs automatically"),
        ]
        for (source, label) in cases {
            #expect(ReadwiseMarker.of(block(inline: [comment(source)]))?.label == label, "\(source)")
        }
    }

    @Test func any_other_comment_or_a_paragraph_with_words_stays_ordinary_text() {
        #expect(ReadwiseMarker.of(block(inline: [comment("<!-- todo -->")])) == nil)
        #expect(ReadwiseMarker.of(block(inline: [comment("<!-- readwise:begin -->")])) == nil)
        let words = InlineRun(text: "hello", marks: [], markAttrs: [:], target: nil)
        #expect(ReadwiseMarker.of(block(inline: [words, comment("<!-- readwise:end -->")])) == nil)
        #expect(ReadwiseMarker.of(block("heading", inline: [comment("<!-- readwise:end -->")])) == nil)
    }

    private func status(error: String? = nil, change: String? = "2026-10-22T08:30:00.000Z") -> ReadwiseStatus {
        ReadwiseStatus(
            connected: true, deviceId: "d1", deviceName: "Studio Mac", rootFolder: "Readwise",
            lastChangeAt: change, error: error
        )
    }

    @Test func a_healthy_status_is_up_to_date_and_names_the_device() {
        let shown = ReadwiseDisplay(status(), devices: [])
        #expect(shown.summary == "Up to date")
        #expect(shown.device == "Studio Mac")
        #expect(shown.problem == nil)
        #expect(shown.lastChange == ISO8601DateFormatter().date(from: "2026-10-22T08:30:00Z"))
    }

    @Test func a_rejected_token_says_where_to_fix_it() {
        let shown = ReadwiseDisplay(status(error: "invalid-token"), devices: [])
        #expect(shown.summary == "Needs attention")
        #expect(shown.problem == "The token on Studio Mac was rejected. Open memry there and paste a new token.")
    }

    @Test func no_claim_reads_as_not_connected() {
        let none = ReadwiseStatus(
            connected: false, deviceId: nil, deviceName: nil, rootFolder: "Readwise", lastChangeAt: nil, error: nil
        )
        #expect(ReadwiseDisplay(none, devices: []).summary == "Not connected")
    }
}
