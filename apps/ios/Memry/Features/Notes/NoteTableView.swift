import MemryCore
import SwiftUI

// A table in a note body.
//
// **Why this is not drawn from the flat block list.** `Notes.blocks` hands
// over one dimension — a depth number — and a table is two. Every cell of
// every row used to arrive at one depth with no row boundary and no column
// count, so a 2×3 table and six paragraphs were indistinguishable.
// `Notes.table(noteId:blockId:)` is the second read that carries rows,
// columns, widths, colours and header flags, and `NoteBlockList` skips the
// table's descendants in the flat list so the content is drawn once.
//
// **Widths are proportions, not pixels.** A column sized in a desktop window
// is wider than a phone is. The document's `colwidth` values are treated as
// relative weights against their own total, and a table wider than the screen
// scrolls sideways rather than crushing every column into illegibility.
//
// **Header emphasis is never colour alone.** A header cell is bolder and sits
// on a distinct surface, and VoiceOver is told the row and column it belongs
// to, so the structure survives greyscale, colour blindness and a screen
// reader alike.

struct NoteTableView: View {
    let table: TableContent?
    var openTarget: ((String) -> Void)?

    var body: some View {
        if let table, !table.rows.isEmpty {
            // Horizontal scrolling rather than compression: a table is a grid
            // and a squeezed column stops being readable well before it stops
            // fitting. `.scrollBounceBehavior` keeps a table that already fits
            // from wobbling, which is the reduced-motion-safe default.
            ScrollView(.horizontal) {
                Grid(horizontalSpacing: 0, verticalSpacing: 0) {
                    ForEach(Array(table.rows.enumerated()), id: \.offset) { rowIndex, row in
                        GridRow {
                            ForEach(Array(row.cells.enumerated()), id: \.offset) { column, cell in
                                NoteTableCellView(
                                    cell: cell,
                                    width: width(of: column, in: table),
                                    openTarget: openTarget
                                )
                                .accessibilityLabel(label(rowIndex, column, cell, table))
                            }
                        }
                    }
                }
                .overlay(
                    RoundedRectangle(cornerRadius: Tokens.Radius.control)
                        .stroke(Tokens.Line.border.color, lineWidth: Tokens.Size.hairline)
                )
                .clipShape(.rect(cornerRadius: Tokens.Radius.control))
                .padding(Tokens.Size.hairline)
            }
            .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
        } else {
            // The block is here and its structure is not. Naming that beats a
            // gap in the middle of a note, and it is what a note synced from
            // a build that predates the table read looks like.
            Text("A table is here")
                .font(Tokens.Typography.supporting.font)
                .foregroundStyle(Tokens.Text.secondary.color)
                .padding(Tokens.Space.inset)
                .frame(maxWidth: .infinity, alignment: .leading)
                .overlay(
                    RoundedRectangle(cornerRadius: Tokens.Radius.card)
                        .stroke(Tokens.Line.border.color, lineWidth: Tokens.Size.hairline)
                )
        }
    }

    /// The minimum width for one column, from its share of the declared
    /// widths.
    ///
    /// A column nobody resized has no width in the document, so it takes the
    /// default rather than collapsing. The declared ones keep their ratio to
    /// each other, which is the part of a desktop resize that is meaningful
    /// on another screen size.
    private func width(of column: Int, in table: TableContent) -> CGFloat {
        guard let declared = table.columnWidths[safe: column] ?? nil else {
            return Self.defaultColumnWidth
        }
        let known = table.columnWidths.compactMap { $0 }
        guard !known.isEmpty else { return Self.defaultColumnWidth }
        let average = known.reduce(0, +) / Double(known.count)
        guard average > 0 else { return Self.defaultColumnWidth }
        return Self.defaultColumnWidth * CGFloat(declared / average)
    }

    /// What VoiceOver says for one cell: its own text, then where it sits.
    ///
    /// Spoken rather than shown, because the row and column of a cell is
    /// information a sighted reader gets from the grid and a screen-reader
    /// user gets from nowhere.
    private func label(
        _ row: Int,
        _ column: Int,
        _ cell: TableCell,
        _ table: TableContent
    ) -> String {
        let text = NoteTableCellView.plainText(of: cell)
        let spoken = text.isEmpty ? "Empty" : text
        if cell.isHeader {
            return "\(spoken), header"
        }
        var parts = [spoken]
        if let heading = headerText(forColumn: column, in: table) {
            parts.append(heading)
        }
        if let heading = headerText(forRow: row, in: table) {
            parts.append(heading)
        }
        parts.append("row \(row + 1), column \(column + 1)")
        return parts.joined(separator: ", ")
    }

    private func headerText(forColumn column: Int, in table: TableContent) -> String? {
        guard table.headerRows > 0, let first = table.rows.first,
              let cell = first.cells[safe: column], cell.isHeader
        else { return nil }
        let text = NoteTableCellView.plainText(of: cell)
        return text.isEmpty ? nil : text
    }

    private func headerText(forRow row: Int, in table: TableContent) -> String? {
        guard table.headerCols > 0, let cell = table.rows[safe: row]?.cells.first,
              cell.isHeader
        else { return nil }
        let text = NoteTableCellView.plainText(of: cell)
        return text.isEmpty ? nil : text
    }

    /// The resting width of a column nobody resized. A point value rather
    /// than a fraction because the table scrolls: there is no container width
    /// to take a fraction of.
    private static let defaultColumnWidth: CGFloat = 132
}

/// One cell.
struct NoteTableCellView: View {
    let cell: TableCell
    let width: CGFloat
    var openTarget: ((String) -> Void)?

    /// Dynamic Type is why the width is a minimum and the height is not set:
    /// a cell grows downward when the text grows, and the row grows with it.
    var body: some View {
        NoteBlocksView(blocks: cell.content, openTarget: openTarget)
            .font(Tokens.Typography.body.font.weight(cell.isHeader ? .semibold : .regular))
            .foregroundStyle(ink)
            .frame(minWidth: width, alignment: frameAlignment)
            .padding(.horizontal, Tokens.Space.medium)
            .padding(.vertical, Tokens.Space.small)
            .background(fill)
            .overlay(
                Rectangle()
                    .stroke(Tokens.Line.border.color, lineWidth: Tokens.Size.hairline)
            )
            .accessibilityElement(children: .combine)
    }

    /// The cell's own ink, or the ordinary one. An unknown colour name leaves
    /// the text alone rather than guessing at it.
    private var ink: Color {
        cell.textColor.flatMap { Tokens.Content.ink(named: $0) }?.color
            ?? Tokens.Text.primary.color
    }

    /// A header with no colour of its own still reads as a header, because
    /// the weight above already says so and this only adds the surface.
    private var fill: Color {
        if let named = cell.backgroundColor, let colour = Tokens.Content.fill(named: named) {
            return colour.color
        }
        return cell.isHeader ? Tokens.Canvas.surface.color : .clear
    }

    private var frameAlignment: Alignment {
        switch cell.textAlignment {
        case "center": .center
        case "right": .trailing
        default: .leading
        }
    }

    /// A cell's text, for the places that need a string rather than a view.
    static func plainText(of cell: TableCell) -> String {
        cell.content
            .flatMap(\.inline)
            .map(\.text)
            .joined()
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

extension Array {
    /// The element at `index`, or `nil` rather than a crash.
    ///
    /// A table read from another device can disagree with this one about how
    /// many columns a row has — a cell added while this copy was offline —
    /// and a note must not crash on arithmetic about a grid.
    subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}
