//
//  EditorMenus.swift
//  The editing affordances: insert, turn into, format, and the two
//  type-specific controls.
//
//  N502 - N508. Tokens only, logical edges only, and every control carries a
//  label rather than relying on its glyph — a VoiceOver user meets these as
//  words, and "B" read aloud is not "bold".
//

import MemryCore
import SwiftUI

/// Every block type a user can insert, as the menu presents them.
///
/// **Driven by a list rather than by the registry**, because the registry
/// includes types a user cannot meaningfully insert from a menu: a `table`
/// needs rows, an `image` needs bytes, and a `taskBlock` belongs to the task
/// surface. Those arrive through their own affordances (N214 for a picture),
/// not through this list.
struct InsertableBlock: Identifiable, Sendable {
    let id: String
    let name: String
    let symbol: String
    /// A heading is one type and three menu entries.
    var level: Int?

    static let all: [InsertableBlock] = [
        .init(id: "paragraph", name: "Text", symbol: "text.alignleft"),
        .init(id: "heading", name: "Heading 1", symbol: "textformat.size.larger", level: 1),
        .init(id: "heading", name: "Heading 2", symbol: "textformat.size", level: 2),
        .init(id: "heading", name: "Heading 3", symbol: "textformat.size.smaller", level: 3),
        .init(id: "bulletListItem", name: "Bulleted list", symbol: "list.bullet"),
        .init(id: "numberedListItem", name: "Numbered list", symbol: "list.number"),
        .init(id: "checkListItem", name: "Check list", symbol: "checklist"),
        .init(id: "toggleListItem", name: "Toggle list", symbol: "chevron.right.circle"),
        .init(id: "quote", name: "Quote", symbol: "quote.opening"),
        .init(id: "codeBlock", name: "Code", symbol: "curlybraces"),
        .init(id: "callout", name: "Callout", symbol: "exclamationmark.bubble"),
        .init(id: "divider", name: "Divider", symbol: "minus"),
    ]

    /// The subset a block can be turned into: everything that holds text.
    ///
    /// A divider is missing on purpose — turning a paragraph into one would
    /// throw the text away, and a menu item that silently deletes what you
    /// wrote is not a menu item.
    static var convertible: [InsertableBlock] {
        all.filter { $0.id != "divider" }
    }
}

/// The insert menu, desktop's slash menu.
///
/// **Reachable from the keyboard accessory, not only by typing `/`.** A
/// discoverable affordance matters more on a phone, where there is no
/// hovering and no tooltip to teach the shortcut.
struct BlockInsertMenu: View {
    let insert: (InsertableBlock) -> Void
    /// `nil` hides the picture entry rather than offering an upload that
    /// cannot happen.
    var insertPicture: (() -> Void)?

    var body: some View {
        Menu {
            ForEach(InsertableBlock.all) { block in
                Button {
                    insert(block)
                } label: {
                    Label(block.name, systemImage: block.symbol)
                }
            }
            if let insertPicture {
                Divider()
                Button {
                    insertPicture()
                } label: {
                    Label("Picture", systemImage: "photo")
                }
            }
        } label: {
            Label("Insert", systemImage: "plus")
                .labelStyle(.iconOnly)
        }
        .accessibilityLabel("Insert a block")
    }
}

/// Turn into, duplicate, move, colour and delete.
struct BlockActionsMenu: View {
    let turnInto: (InsertableBlock) -> Void
    let duplicate: () -> Void
    let moveUp: () -> Void
    let moveDown: () -> Void
    let setColour: (String) -> Void
    let delete: () -> Void

    var body: some View {
        Menu {
            Menu {
                ForEach(InsertableBlock.convertible) { block in
                    Button {
                        turnInto(block)
                    } label: {
                        Label(block.name, systemImage: block.symbol)
                    }
                }
            } label: {
                Label("Turn into", systemImage: "arrow.triangle.2.circlepath")
            }

            Menu {
                // "Default" first: getting back to no colour is the action a
                // user needs most and the one a colour grid usually hides.
                Button("Default") { setColour("default") }
                ForEach(Tokens.Content.names, id: \.self) { name in
                    Button(name.capitalized) { setColour(name) }
                }
            } label: {
                Label("Colour", systemImage: "paintpalette")
            }

            Button {
                duplicate()
            } label: {
                Label("Duplicate", systemImage: "plus.square.on.square")
            }
            Button {
                moveUp()
            } label: {
                Label("Move up", systemImage: "arrow.up")
            }
            Button {
                moveDown()
            } label: {
                Label("Move down", systemImage: "arrow.down")
            }

            Divider()
            Button(role: .destructive) {
                delete()
            } label: {
                Label("Delete", systemImage: "trash")
            }
        } label: {
            Label("Block actions", systemImage: "ellipsis.circle")
                .labelStyle(.iconOnly)
        }
        .accessibilityLabel("Actions for this block")
    }
}

/// The five marks, plus colour and link, over the current selection.
///
/// **Every button is a word to VoiceOver.** A toolbar of glyphs reads as
/// nothing useful, and bold is the one formatting control a screen-reader
/// user is most likely to want.
struct FormattingToolbar: View {
    let apply: (String, String?) -> Void
    let remove: (String) -> Void
    /// Which marks the selection already carries, so a toggle can turn one
    /// off rather than only on.
    let active: Set<String>
    let addLink: () -> Void

    private static let marks: [(id: String, name: String, symbol: String)] = [
        ("bold", "Bold", "bold"),
        ("italic", "Italic", "italic"),
        ("underline", "Underline", "underline"),
        ("strike", "Strikethrough", "strikethrough"),
        ("code", "Code", "chevron.left.forwardslash.chevron.right"),
    ]

    var body: some View {
        HStack(spacing: Tokens.Space.small) {
            ForEach(Self.marks, id: \.id) { mark in
                Button {
                    if active.contains(mark.id) {
                        remove(mark.id)
                    } else {
                        apply(mark.id, nil)
                    }
                } label: {
                    Image(systemName: mark.symbol)
                }
                .accessibilityLabel(mark.name)
                // The state, not just the name: "Bold, on" is the whole
                // answer and "Bold" is half of one.
                .accessibilityAddTraits(active.contains(mark.id) ? [.isSelected] : [])
            }

            Menu {
                Button("Default") { apply("textColor", "default") }
                ForEach(Tokens.Content.names, id: \.self) { name in
                    Button(name.capitalized) { apply("textColor", name) }
                }
            } label: {
                Image(systemName: "paintpalette")
            }
            .accessibilityLabel("Text colour")

            Button(action: addLink) {
                Image(systemName: "link")
            }
            .accessibilityLabel("Add a link")
        }
        .font(Tokens.Typography.body.font)
        .foregroundStyle(Tokens.Text.primary.color)
    }
}

/// A code block's language, and a copy action.
struct CodeBlockControls: View {
    let language: String?
    let setLanguage: (String) -> Void
    let copy: () -> Void

    /// The languages the picker offers. Not every language in the world —
    /// a long list on a phone is worse than a short one plus the ability to
    /// leave it alone.
    private static let languages = [
        "javascript", "typescript", "swift", "rust", "python", "go", "ruby",
        "java", "kotlin", "c", "cpp", "csharp", "html", "css", "json", "yaml",
        "markdown", "bash", "sql", "text",
    ]

    var body: some View {
        HStack {
            Menu {
                ForEach(Self.languages, id: \.self) { name in
                    Button(name) { setLanguage(name) }
                }
            } label: {
                Text(language ?? "Plain text")
                    .font(Tokens.Typography.caption.font)
            }
            .accessibilityLabel("Language: \(language ?? "plain text")")

            Spacer()

            Button(action: copy) {
                Label("Copy", systemImage: "doc.on.doc")
                    .labelStyle(.iconOnly)
                    .font(Tokens.Typography.caption.font)
            }
            .accessibilityLabel("Copy this code")
        }
        .foregroundStyle(Tokens.Text.secondary.color)
    }
}

/// A callout's type, which is what decides its colour and its icon.
struct CalloutTypeMenu: View {
    let type: String
    let setType: (String) -> Void

    private static let types: [(id: String, name: String, symbol: String)] = [
        ("info", "Info", "info.circle"),
        ("warning", "Warning", "exclamationmark.triangle"),
        ("error", "Error", "xmark.octagon"),
        ("success", "Success", "checkmark.circle"),
    ]

    var body: some View {
        Menu {
            ForEach(Self.types, id: \.id) { entry in
                Button {
                    setType(entry.id)
                } label: {
                    Label(entry.name, systemImage: entry.symbol)
                }
            }
        } label: {
            Image(systemName: Self.types.first { $0.id == type }?.symbol ?? "info.circle")
        }
        .accessibilityLabel("Callout type: \(type)")
    }
}

/// Undo and redo, naming what they will do.
struct EditorHistoryControls: View {
    let stack: EditorUndoStack
    let undo: () -> Void
    let redo: () -> Void

    var body: some View {
        HStack(spacing: Tokens.Space.small) {
            Button(action: undo) {
                Image(systemName: "arrow.uturn.backward")
            }
            .disabled(!stack.canUndo)
            // Named, so it says what it will undo rather than only "Undo".
            .accessibilityLabel(stack.undoName.map { "Undo \($0.lowercased())" } ?? "Undo")

            Button(action: redo) {
                Image(systemName: "arrow.uturn.forward")
            }
            .disabled(!stack.canRedo)
            .accessibilityLabel(stack.redoName.map { "Redo \($0.lowercased())" } ?? "Redo")
        }
    }
}
