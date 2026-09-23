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
                                    openTarget: openTarget,
                                    toggleCheckbox: editing.flatMap { editing in
                                        tableId.map { id in
                                            { ordinal, checked in
                                                editing.setCellCheckbox(
                                                    id, rowIndex, column, ordinal, checked
                                                )
                                            }
                                        }
                                    }
                                )
                                .accessibilityLabel(label(rowIndex, column, cell, table))
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
    /// Ticks or unticks the `index`-th checkbox in this cell (N605). `nil`
    /// leaves the boxes drawn but inert, which is what a read-only note gets.
    var toggleCheckbox: ((Int, Bool) -> Void)?

    /// Dynamic Type is why the width is a minimum and the height is not set:
    /// a cell grows downward when the text grows, and the row grows with it.
    var body: some View {
        NoteBlocksView(
            blocks: cell.content,
            openTarget: openTarget,
            checkboxBase: toggleCheckbox == nil ? nil : 0,
            inheritsInk: true
        )
            // The cell's own handler, ahead of the note-wide one: a checkbox
            // link carries an ordinal that only means something here.
            .environment(\.openURL, OpenURLAction { url in
                guard
                    let ordinal = NoteInline.checkboxTarget(of: url),
                    let toggleCheckbox
                else {
                    return .systemAction
                }
                toggleCheckbox(ordinal, !isTicked(ordinal))
                return .handled
            })
            .font(Tokens.Typography.body.font.weight(cell.isHeader ? .semibold : .regular))
            .foregroundStyle(ink)
            .frame(minWidth: width, alignment: frameAlignment)
            .padding(.horizontal, Tokens.Space.medium)
            .padding(.vertical, Tokens.Space.small)
            // Fill the row's height, so a cell beside a taller one (a picture,
            // a wrapped line) keeps its fill and its border to the row's edge
            // instead of floating in a gap.
            .frame(
                maxHeight: .infinity,
                alignment: Alignment(horizontal: frameAlignment.horizontal, vertical: .top)
            )
            .background(fill)
            .overlay(
                Rectangle()
                    .stroke(Tokens.Line.border.color, lineWidth: Tokens.Size.hairline)
            )
            .accessibilityElement(children: .combine)
    }

    /// Whether the `ordinal`-th checkbox in this cell is currently ticked, so
    /// a tap can write the opposite rather than always writing `true`.
    private func isTicked(_ ordinal: Int) -> Bool {
        let boxes = cell.content
            .flatMap(\.inline)
            .filter { $0.marks.contains("inlineCheckbox") }
        guard ordinal < boxes.count else { return false }
        return boxes[ordinal].markAttrs["inlineCheckbox.checked"] == "true"
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

/// What a table needs to be editable (N505).
///
/// Closures rather than the editor model, so this view stays in the read
/// feature and depends on four functions instead of on a type.
/// Every closure takes the table's own block id first, because one note can
/// hold several tables and a cell knows its row and column but not which grid
/// it belongs to.
struct NoteTableEditing {
    let insertRow: (String, Int) -> Void
    let deleteRow: (String, Int) -> Void
    let insertColumn: (String, Int) -> Void
    let deleteColumn: (String, Int) -> Void
    let setCellColour: (String, Int, Int, String) -> Void
    /// Ticks or unticks the `index`-th inline checkbox in a cell (N605).
    let setCellCheckbox: (String, Int, Int, Int, Bool) -> Void
}

/// The row and column actions, attached to a cell.
private struct NoteTableCellActions: ViewModifier {
    let editing: NoteTableEditing?
    /// The `table` block this cell belongs to. Without it there is no way to
    /// say which grid an insert applies to.
    let tableId: String?
    let row: Int
    let column: Int

    func body(content: Content) -> some View {
        guard let editing, let tableId else { return AnyView(content) }
        return AnyView(
            content.contextMenu {
                Button {
                    editing.insertRow(tableId, row)
                } label: {
                    Label("Insert row above", systemImage: "arrow.up.to.line")
                }
                Button {
                    editing.insertRow(tableId, row + 1)
                } label: {
                    Label("Insert row below", systemImage: "arrow.down.to.line")
                }
                Button {
                    editing.insertColumn(tableId, column)
                } label: {
                    Label("Insert column before", systemImage: "arrow.left.to.line")
                }
                Button {
                    editing.insertColumn(tableId, column + 1)
                } label: {
                    Label("Insert column after", systemImage: "arrow.right.to.line")
                }

                Menu {
                    Button("Default") { editing.setCellColour(tableId, row, column, "default") }
                    ForEach(Tokens.Content.names, id: \.self) { name in
                        Button(name.capitalized) {
                            editing.setCellColour(tableId, row, column, name)
                        }
                    }
                } label: {
                    Label("Cell colour", systemImage: "paintpalette")
                }

                Divider()
                Button(role: .destructive) {
                    editing.deleteRow(tableId, row)
                } label: {
                    Label("Delete row", systemImage: "trash")
                }
                Button(role: .destructive) {
                    editing.deleteColumn(tableId, column)
                } label: {
                    Label("Delete column", systemImage: "trash")
                }
            }
        )
    }
}
