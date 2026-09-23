import MemryCore
import SwiftUI
import UIKit

// The body as a list of blocks, split from `NoteBlockView.swift`.

struct NoteBlocksView: View {
    let blocks: [Block]
    /// Where a wiki link goes when it is tapped. `nil` while nothing can
    /// resolve one, which is honest: a link that looks tappable and does
    /// nothing is worse than a link that does not look tappable.
    var openTarget: ((String) -> Void)?
    /// Where a `#tag` goes when it is tapped (N600). `nil` leaves tags marked
    /// but inert, which is what a context with no stack gets.
    var openTag: ((String) -> Void)?
    /// One table's structure, by the block id of its `table` block.
    ///
    /// A second read rather than a field on `Block`, because rows and columns
    /// are two dimensions and `depth` is one. `nil` while no source is wired,
    /// and a table then draws as the placeholder rather than as nothing.
    var tableContent: ((String) -> TableContent?)?
    /// What a block's `url` points at, by the rule the core owns (Q4).
    ///
    /// `nil` while nothing can resolve one, which draws every attachment as a
    /// placeholder rather than pretending the bytes are missing.
    var attachment: ((String) -> BlockAttachment)?
    /// Detaches an attachment. `nil` hides the action rather than offering
    /// one that cannot work.
    var removeAttachment: ((String) async -> Void)?
    /// Makes a text-bearing block editable (N302).
    ///
    /// `nil` renders the note read-only, which is what a vault with no
    /// identity to sign a write with gets — the keyboard is **absent** rather
    /// than present and refusing.
    var editing: NoteEditingBridge?
    /// Row and column editing for any table in this note (N505).
    var tableEditing: NoteTableEditing?
    /// Set by a table cell so its checkboxes can be numbered and tapped
    /// (N605). `nil` everywhere else.
    var checkboxBase: Int?

    /// `true` inside a table cell, whose own `textColor` is the ink. Anywhere
    /// else the body is drawn in the ordinary ink.
    var inheritsInk = false

    /// Toggles the reader has opened or closed on this screen, by row.
    ///
    /// A view state rather than a write: folding a toggle to read past it is
    /// not an edit, and writing `open` for it would change the note on every
    /// other device.
    @State private var flipped: Set<Int> = []

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.medium) {
            ForEach(NoteBlockList.rows(of: blocks, flipped: flipped), id: \.id) { row in
                NoteBlockView(
                    block: row.block,
                    marker: row.marker,
                    isOpen: row.isOpen,
                    toggle: {
                        if flipped.contains(row.id) {
                            flipped.remove(row.id)
                        } else {
                            flipped.insert(row.id)
                        }
                    },
                    openTarget: openTarget,
                    tableContent: tableContent,
                    attachment: attachment,
                    removeAttachment: removeAttachment,
                    editing: editing,
                    tableEditing: tableEditing,
                    checkboxBase: checkboxBase.map { base in
                        base + NoteBlockList.checkboxesBefore(row.id, in: blocks)
                    }
                )
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .modifier(BlockInk(color: inheritsInk ? nil : Tokens.Text.primary.color))
        // Wiki links are `AttributedString` links, so the platform already
        // draws and hits them — including for VoiceOver's link rotor, which a
        // tap gesture over styled text would never have reached. This is the
        // handler that turns one back into a note.
        .environment(\.openURL, OpenURLAction { url in
            if let tag = NoteInline.tagTarget(of: url) {
                guard let openTag else {
                    // Marked but not going anywhere, which is the honest
                    // answer for a context with no stack to push onto.
                    return .handled
                }
                openTag(tag)
                return .handled
            }
            guard let target = NoteInline.wikiTarget(of: url), let openTarget else {
                // No handler, or not one of ours: hand it back to the system
                // rather than swallowing it. A real `https://` link in a note
                // still opens.
                return .systemAction
            }
            openTarget(target)
            return .handled
        })
    }
}
