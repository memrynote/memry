import SwiftUI

// `DESIGN.md` › Tablet › Measures. A screen's content column stops at its
// measure and sits centred in whatever is left, so a 13" iPad reads a note at
// a line length a person can follow instead of edge to edge. The measures are
// wider than any iPhone in portrait, which therefore lays out as before.

extension EnvironmentValues {
    /// The surface runs the full pane instead of the reading measure.
    ///
    /// Nothing sets it yet. #4376 sets it from desktop's per-device editor
    /// width, a note's `fullWidth` frontmatter, and the journal override.
    @Entry var fullWidthReading = false

    /// A wide block breaks out of the reading measure to the full pane.
    ///
    /// Off inside a block's own box, such as a column or an embedded note,
    /// where the pane is not the block's to take.
    @Entry var paneBreakout = true
}

/// A picture of a page in a note, such as a PDF or a whiteboard: as tall as
/// the width it gets, up to the reading measure, and never below the 420pt a
/// phone has always shown, so a 13" iPad shows a page instead of a strip and
/// a phone lays out as before.
enum PreviewMeasure {
    static let minimumHeight: CGFloat = 420

    static func height(forWidth width: CGFloat) -> CGFloat {
        max(minimumHeight, min(width, Tokens.Size.reading))
    }
}

/// The reading measure, lifted when the surface is full width.
private struct ReadingColumn: ViewModifier {
    @Environment(\.fullWidthReading) private var fullWidth

    func body(content: Content) -> some View {
        content.measuredColumn(fullWidth ? .infinity : Tokens.Size.reading)
    }
}

/// A list or form capped by widening its safe area, not by narrowing its
/// frame: the margins outside the column still scroll and still show the
/// list's own background.
private struct MeasuredScrollContent: ViewModifier {
    let measure: CGFloat
    @State private var width: CGFloat = 0

    func body(content: Content) -> some View {
        content
            .safeAreaPadding(.horizontal, max(0, (width - measure) / 2))
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
    }
}

/// A block drawn across the pane, its gutters kept, while the reading
/// column around it stays at its measure. The frame after the pane width
/// reports the column's own width to the column and centres the wider block
/// on it, so the column's other blocks do not move. A scroll view inside (a
/// table) starts its content at the column's leading edge, so a narrow table
/// lines up with the text and a wide one runs on to the pane's far edge.
private struct PaneBreakout: ViewModifier {
    @Environment(\.paneBreakout) private var breaksOut
    @State private var pane: CGFloat = 0
    @State private var column: CGFloat = 0

    func body(content: Content) -> some View {
        if breaksOut {
            content
                .contentMargins(.leading, max(0, (pane - column) / 2), for: .scrollContent)
                .containerRelativeFrame(.horizontal) { length, _ in
                    max(0, length - 2 * Tokens.Space.screenInline)
                }
                .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { pane = $0 }
                .frame(minWidth: 0, maxWidth: .infinity)
                .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { column = $0 }
        } else {
            content
        }
    }
}

extension View {
    /// Caps the column at `measure` and centres it in the width it is
    /// offered. Narrower than `measure`, the column takes all of it.
    ///
    /// Apply it to the content inside the screen's inline padding, so the
    /// measure is the text's width and the padding stays the gutter.
    func measuredColumn(_ measure: CGFloat) -> some View {
        frame(maxWidth: measure).frame(maxWidth: .infinity)
    }

    /// `measuredColumn` for a `List` or `Form`, which scrolls and paints its
    /// own background edge to edge: a frame would leave the margins dead to
    /// a swipe and a different colour from the list.
    func measuredScrollContent(_ measure: CGFloat) -> some View {
        modifier(MeasuredScrollContent(measure: measure))
    }

    /// A Settings page: the list capped at the reading measure.
    func settingsPage() -> some View {
        measuredScrollContent(Tokens.Size.reading)
    }

    /// A table or whiteboard in a note or journal day: the full pane, not
    /// the reading measure (DESIGN.md › Tablet › Measures, Q3).
    func paneBreakout() -> some View {
        modifier(PaneBreakout())
    }

    /// A note or journal day's column: the reading measure, unless the
    /// surface is set to full width.
    func readingColumn() -> some View {
        modifier(ReadingColumn())
    }
}
