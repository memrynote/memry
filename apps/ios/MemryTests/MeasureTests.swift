import SwiftUI
import Testing
import UIKit

@testable import Memry

// #4340. A column on a wide window stops at its measure and sits centred; on a
// phone it keeps the whole width, so compact layouts do not move. The frames
// are read from a real hosted layout, not from the modifier's arguments.

@MainActor
@Suite("Content measures")
struct MeasureTests {
    @Test func a_form_on_a_wide_window_is_capped_and_centred() async throws {
        let frame = try await layout(width: 1200) { $0.measuredColumn(Tokens.Size.form) }
        #expect(frame.width == Tokens.Size.form)
        #expect(frame.midX == 600)
    }

    @Test func a_column_narrower_than_its_measure_keeps_the_whole_width() async throws {
        let frame = try await layout(width: 402) { $0.readingColumn() }
        #expect(frame.width == 402)
        #expect(frame.minX == 0)
    }

    @Test func a_reading_column_stops_at_the_reading_measure() async throws {
        let frame = try await layout(width: 1200) { $0.readingColumn() }
        #expect(frame.width == Tokens.Size.reading)
        #expect(frame.midX == 600)
    }

    /// The hook #4376 sets for a full-width note, journal, or device.
    @Test func a_full_width_surface_lifts_the_reading_measure() async throws {
        let frame = try await layout(width: 1200) {
            $0.readingColumn().environment(\.fullWidthReading, true)
        }
        #expect(frame.width == 1200)
    }

    /// A Settings list keeps its rows inside the reading measure, centred.
    @Test func a_list_on_a_wide_window_keeps_its_rows_in_the_measure() async throws {
        let frame = try await layout(width: 1200) { column in
            List { column }.measuredScrollContent(Tokens.Size.reading)
        }
        #expect(frame.width <= Tokens.Size.reading)
        #expect(frame.width > Tokens.Size.reading - 100)
        #expect(frame.midX == 600)
    }

    /// Q3: a table or whiteboard takes the pane, gutters kept, and the text
    /// around it stays at the reading measure.
    @Test func a_wide_block_breaks_out_to_the_pane() async throws {
        let (text, block) = try await page(width: 1200)
        #expect(text.width == Tokens.Size.reading)
        #expect(text.midX == 600)
        #expect(block.width == 1200 - 2 * Tokens.Space.screenInline)
        #expect(block.midX == 600)
    }

    @Test func a_wide_block_on_a_phone_keeps_the_column() async throws {
        let (text, block) = try await page(width: 402)
        #expect(block.minX == text.minX)
        #expect(block.width == text.width)
    }

    /// Inside a column or an embedded note the block keeps its box.
    @Test func a_block_in_its_own_box_does_not_break_out() async throws {
        let (text, block) = try await page(width: 1200, breakout: false)
        #expect(block.minX == text.minX)
        #expect(block.width == text.width)
    }

    /// Hosts a note-like page, a text row and a breakout block in a reading
    /// column inside the screen gutter, and returns where both landed.
    private func page(width: CGFloat, breakout: Bool = true) async throws -> (CGRect, CGRect) {
        let block = FrameBox()
        let text = try await layout(width: width) { textRow in
            ScrollView {
                VStack(alignment: .leading) {
                    textRow
                    Color.clear
                        .frame(maxWidth: .infinity, minHeight: 10, maxHeight: 10)
                        .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { block.frame = $0 }
                        .paneBreakout()
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .readingColumn()
                .padding(.horizontal, Tokens.Space.screenInline)
            }
            .environment(\.paneBreakout, breakout)
        }
        return try (text, #require(block.frame))
    }

    /// Hosts a column filling the width it is given under `measure`, and
    /// returns where the column landed.
    private func layout(
        width: CGFloat,
        measure: @escaping (AnyView) -> some View
    ) async throws -> CGRect {
        let box = FrameBox()
        let column = Color.clear
            .frame(maxWidth: .infinity, maxHeight: 10)
            .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { box.frame = $0 }
        let scene = try #require(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: width, height: 200)
        let host = UIHostingController(rootView: measure(AnyView(column)).ignoresSafeArea())
        host.safeAreaRegions = []
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        for _ in 0 ..< 40 where box.frame == nil {
            try await Task.sleep(for: .milliseconds(25))
        }
        // A list measures its width first and pads on the next pass.
        try await Task.sleep(for: .milliseconds(200))
        return try #require(box.frame)
    }
}

@MainActor
private final class FrameBox {
    var frame: CGRect?
}
