import MemryCore
import SwiftUI

/// One cell.
struct NoteTableCellView: View {
    let cell: TableCell
    let width: CGFloat
    var openTarget: ((String) -> Void)?
    /// Ticks or unticks the `index`-th checkbox in this cell (N605). `nil`
    /// leaves the boxes drawn but inert, which is what a read-only note gets.
    var toggleCheckbox: ((Int, Bool) -> Void)?
    /// Writes this cell's text. `nil` draws the content read-only.
    var setText: ((String) -> Void)?
    var focus: FocusState<NoteTableCellAddress?>.Binding
    var address: NoteTableCellAddress
    /// Where Return moves the caret, or `nil` on the last cell.
    var next: NoteTableCellAddress?
    var label: String

    /// Dynamic Type is why the width is a minimum and the height is not set:
    /// a cell grows downward when the text grows, and the row grows with it.
    var body: some View {
        content
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
    }

    @ViewBuilder private var content: some View {
        if let setText {
            NoteTableCellField(
                text: Self.plainText(of: cell), commit: setText, focus: focus, address: address, next: next
            )
            // A text field fills the column, so the frame alignment below
            // cannot place its text; the field has to align it itself.
            .multilineTextAlignment(Self.alignment(of: cell))
            .accessibilityLabel(label)
        } else {
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
            .accessibilityElement(children: .combine)
            .accessibilityLabel(label)
        }
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

    /// The cell's `textAlignment` as SwiftUI spells it.
    static func alignment(of cell: TableCell) -> TextAlignment {
        switch cell.textAlignment {
        case "center": .center
        case "right": .trailing
        default: .leading
        }
    }

    private var frameAlignment: Alignment {
        switch Self.alignment(of: cell) {
        case .center: .center
        case .trailing: .trailing
        case .leading: .leading
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

/// One cell's place in its table, which is how a cell is addressed (Q1).
struct NoteTableCellAddress: Hashable {
    let row: Int
    let column: Int

    /// The cell Return moves to: across the row, then down to the next one.
    func next(in table: TableContent) -> NoteTableCellAddress? {
        if column + 1 < table.rows[safe: row]?.cells.count ?? 0 {
            return NoteTableCellAddress(row: row, column: column + 1)
        }
        return row + 1 < table.rows.count ? NoteTableCellAddress(row: row + 1, column: 0) : nil
    }
}

/// A plain-text cell as a text field. The draft is written when the caret
/// leaves the cell, not per keystroke, so one cell edit is one document write.
private struct NoteTableCellField: View {
    let text: String
    let commit: (String) -> Void
    let focus: FocusState<NoteTableCellAddress?>.Binding
    let address: NoteTableCellAddress
    let next: NoteTableCellAddress?
    @State private var draft: String

    init(
        text: String,
        commit: @escaping (String) -> Void,
        focus: FocusState<NoteTableCellAddress?>.Binding,
        address: NoteTableCellAddress,
        next: NoteTableCellAddress?
    ) {
        self.text = text
        self.commit = commit
        self.focus = focus
        self.address = address
        self.next = next
        _draft = State(initialValue: text)
    }

    private var isFocused: Bool { focus.wrappedValue == address }

    var body: some View {
        TextField("", text: $draft)
            .focused(focus, equals: address)
            .submitLabel(next == nil ? .done : .next)
            .onSubmit { focus.wrappedValue = next }
            .onChange(of: text) { if !isFocused { draft = text } }
            .onChange(of: isFocused) { _, focused in
                if !focused { save() }
            }
            .onDisappear(perform: save)
    }

    private func save() {
        if draft != text { commit(draft) }
    }
}
