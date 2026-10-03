import SwiftUI

/// What a table needs to be editable (N505).
///
/// Closures rather than the editor model, so this view stays in the read
/// feature and depends on functions instead of on a type.
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
    let setCellText: (String, Int, Int, String) -> Void
    /// Whether the editor asked for the caret in this table, clearing the
    /// request so only one table takes it.
    let takeFocus: @MainActor (String) -> Bool
}

extension NoteTableEditing {
    /// Every table edit through the note's editor, re-reading the note after
    /// each so the grid shows the document rather than a guess.
    @MainActor
    init(editor: NoteEditorViewModel, reload: @escaping @MainActor () async -> Void) {
        self.init(
            insertRow: { tableId, row in
                Task { @MainActor in
                    await editor.insertRow(tableId, at: row)
                    await reload()
                }
            },
            deleteRow: { tableId, row in
                Task { @MainActor in
                    await editor.deleteRow(tableId, at: row)
                    await reload()
                }
            },
            insertColumn: { tableId, column in
                Task { @MainActor in
                    await editor.insertColumn(tableId, at: column)
                    await reload()
                }
            },
            deleteColumn: { tableId, column in
                Task { @MainActor in
                    await editor.deleteColumn(tableId, at: column)
                    await reload()
                }
            },
            setCellColour: { tableId, row, column, colour in
                Task { @MainActor in
                    await editor.setCellProp(tableId, row: row, column: column, "backgroundColor", colour)
                    await reload()
                }
            },
            setCellCheckbox: { tableId, row, column, index, checked in
                Task { @MainActor in
                    await editor.setCellCheckbox(
                        tableId, row: row, column: column, index: index, checked: checked
                    )
                    await reload()
                }
            },
            setCellText: { tableId, row, column, text in
                Task { @MainActor in
                    await editor.setCell(tableId, row: row, column: column, text: text)
                    await reload()
                }
            },
            takeFocus: { tableId in
                guard editor.session.pendingFocus == tableId else { return false }
                editor.session.pendingFocus = nil
                return true
            }
        )
    }
}

/// The row and column actions, attached to a cell.
struct NoteTableCellActions: ViewModifier {
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
