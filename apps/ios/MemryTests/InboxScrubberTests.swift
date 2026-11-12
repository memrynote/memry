import CoreGraphics
import Testing

@testable import Memry

// #4342: a tap on the voice memo's waveform seeks against the bars, not the
// full row, so the last bar is the end on an iPhone row and an iPad row alike.

@Suite("Inbox voice scrubber")
struct InboxScrubberTests {
    private let count = InboxScrubber.barCount
    private let pitch = InboxScrubber.barWidth + InboxScrubber.barGap

    private func centre(ofBar index: Int) -> CGFloat {
        CGFloat(index) * pitch + InboxScrubber.barWidth / 2
    }

    @Test(arguments: [280.0, 900.0])
    func the_first_and_last_bars_are_the_ends_of_the_memo(rowWidth: CGFloat) {
        let first = InboxScrubber.seekFraction(x: centre(ofBar: 0), rowWidth: rowWidth, barCount: count)
        let last = InboxScrubber.seekFraction(x: centre(ofBar: count - 1), rowWidth: rowWidth, barCount: count)
        #expect(first <= 0.05)
        #expect(last >= 0.95)
    }

    @Test func a_tap_past_the_bars_seeks_to_the_end() {
        #expect(InboxScrubber.seekFraction(x: 700, rowWidth: 900, barCount: count) == 1)
        #expect(InboxScrubber.seekFraction(x: -4, rowWidth: 900, barCount: count) == 0)
    }

    @Test func a_row_narrower_than_the_bars_maps_against_the_row() {
        #expect(InboxScrubber.seekFraction(x: 150, rowWidth: 150, barCount: count) == 1)
    }
}
