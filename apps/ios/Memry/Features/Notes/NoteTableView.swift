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
    /// Row and column editing (N505). `nil` leaves the table read-only,
    /// which is what a vault with no identity to write with gets.
    var editing: NoteTableEditing?
    /// The block id of this `table`, needed to address an edit at it.
    var tableId: String?

    @FocusState private var focusedCell: NoteTableCellAddress?

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
                                let address = NoteTableCellAddress(row: rowIndex, column: column)
                                let setText = textEdit(for: cell, at: address)
                                NoteTableCellView(
                                    cell: cell,
                                    width: width(of: column, in: table),
                                    openTarget: openTarget,
                                    toggleCheckbox: editing.flatMap { editing in
                                        tableId.map { id in
                                            { ordinal, checked in
                                                editing.setCellCheckbox(
                                                    id, rowIndex, column, ordinal, checked
                                                )
                                            }
                                        }
                                    },
                                    setText: setText,
                                    focus: $focusedCell,
                                    address: address,
                                    next: address.next(in: table),
                                    label: label(rowIndex, column, cell, table, withText: setText == nil)
                                )
                                // The structure actions live on the cell
                                // because a row and a column are both reached
                                // from one, and a phone has no margin to put
                                // a handle in.
                                .modifier(
                                    NoteTableCellActions(
                                        editing: editing,
                                        tableId: tableId,
                                        row: rowIndex,
                                        column: column
                                    )
                                )
                            }
                        }
                    }
                }
                // Each row as tall as its tallest cell and no taller: the
                // cells fill their row, and without this the grid takes every
                // height it is offered and the rows balloon.
                .fixedSize(horizontal: false, vertical: true)
                .overlay(
                    RoundedRectangle(cornerRadius: Tokens.Radius.control)
                        .stroke(Tokens.Line.border.color, lineWidth: Tokens.Size.hairline)
                )
                .clipShape(.rect(cornerRadius: Tokens.Radius.control))
                .padding(Tokens.Size.hairline)
            }
            .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
            .onAppear(perform: takePendingFocus)
            .onChange(of: table) { takePendingFocus() }
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

    /// Writes one cell's text, for a cell a text field can hold without loss.
    /// A cell with marks, links or checkboxes stays drawn and read-only,
    /// because `setCellText` replaces the cell with plain text.
    private func textEdit(for cell: TableCell, at address: NoteTableCellAddress) -> ((String) -> Void)? {
        guard let editing, let tableId, cell.content.count <= 1,
              cell.content.allSatisfy({ $0.inline.allSatisfy(\.marks.isEmpty) })
        else { return nil }
        return { text in editing.setCellText(tableId, address.row, address.column, text) }
    }

    /// A table just inserted from the catalog takes the caret in its first
    /// cell, as desktop's `/table` does.
    private func takePendingFocus() {
        guard let editing, let tableId, editing.takeFocus(tableId) else { return }
        focusedCell = NoteTableCellAddress(row: 0, column: 0)
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
    /// An editable cell leaves its text out, because a text field speaks its
    /// value after its label.
    ///
    /// Spoken rather than shown, because the row and column of a cell is
    /// information a sighted reader gets from the grid and a screen-reader
    /// user gets from nowhere.
    private func label(
        _ row: Int,
        _ column: Int,
        _ cell: TableCell,
        _ table: TableContent,
        withText: Bool
    ) -> String {
        let text = NoteTableCellView.plainText(of: cell)
        var parts = withText ? [text.isEmpty ? "Empty" : text] : []
        if cell.isHeader {
            return (parts + ["header", "column \(column + 1)"]).joined(separator: ", ")
        }
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
