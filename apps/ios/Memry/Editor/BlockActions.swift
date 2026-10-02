//
//  BlockActions.swift
//  Desktop's block side menu, as a native context menu: turn into, text and
//  background colour, move up, move down, duplicate, delete.
//
//  **Where the long press lands.** An editable block is a text view, and a
//  long press inside it belongs to text selection. So the menu hangs off a
//  handle in the page's leading margin, drawn beside the block that has the
//  caret, as desktop hangs it off the drag handle beside the hovered block.
//  A block that is not a text view (a divider, a picture, a callout) has no
//  selection to fight with, and the whole block takes the long press.
//
//  No "Copy link to block": desktop's side menu has none, and a block id in a
//  stored link dies with the document that minted it (`memry-links.ts`).
//

import MemryCore
import SwiftUI
import UIKit

/// The blocks either side of one block at its own depth, which is what Move up
/// and Move down swap it with.
///
/// Siblings only: a block at the top or bottom of its parent stays inside it
/// rather than being lifted out, so a list item never silently leaves its list.
struct BlockSiblings: Equatable {
    var previous: String?
    var next: String?

    /// Over the flat list the core returns, where nesting is `depth`: the
    /// nearest block at the same depth, stopping at a shallower one (the
    /// parent's boundary). Deeper blocks between are the sibling's children.
    static func of(_ index: Int, in blocks: [Block]) -> BlockSiblings {
        guard blocks.indices.contains(index) else { return BlockSiblings() }
        let depth = blocks[index].depth
        func sibling(_ candidates: some Sequence<Block>) -> String? {
            for block in candidates {
                if block.depth < depth { return nil }
                if block.depth == depth { return block.id }
            }
            return nil
        }
        return BlockSiblings(
            previous: sibling(blocks[..<index].reversed()),
            next: sibling(blocks[(index + 1)...])
        )
    }
}

extension EditorUndoStep {
    /// Move up is the previous sibling moving below this block, so the whole
    /// step is one move each way whatever the block's parent is.
    static func moveUp(blockId: String, siblings: BlockSiblings) -> EditorUndoStep? {
        guard let previous = siblings.previous else { return nil }
        return EditorUndoStep(
            name: "Move up",
            backward: .moveBlock(blockId: blockId, afterBlockId: previous),
            forward: .moveBlock(blockId: previous, afterBlockId: blockId)
        )
    }

    static func moveDown(blockId: String, siblings: BlockSiblings) -> EditorUndoStep? {
        guard let next = siblings.next else { return nil }
        return EditorUndoStep(
            name: "Move down",
            backward: .moveBlock(blockId: next, afterBlockId: blockId),
            forward: .moveBlock(blockId: blockId, afterBlockId: next)
        )
    }

    /// The core copies the block with its children, props and marks; undo
    /// deletes the copy.
    static func duplicate(blockId: String, newBlockId: String) -> EditorUndoStep {
        EditorUndoStep(
            name: "Duplicate",
            backward: .delete(blockId: newBlockId),
            forward: .duplicate(blockId: blockId, newBlockId: newBlockId)
        )
    }

    /// Undo puts the block back from the snapshot read before the delete,
    /// children, marks and ids included; redo deletes it again by that id.
    static func delete(blockId: String, snapshot: String) -> EditorUndoStep {
        EditorUndoStep(
            name: "Delete",
            backward: .restoreBlock(snapshot: snapshot),
            forward: .delete(blockId: blockId)
        )
    }

    /// A type change as the block was before and after it, so undo brings
    /// back a heading's level, colours and marks rather than the type's
    /// defaults, and redo the level it was given.
    static func turnInto(before: String, after: String) -> EditorUndoStep {
        EditorUndoStep(
            name: "Turn into",
            backward: .restoreBlock(snapshot: before),
            forward: .restoreBlock(snapshot: after)
        )
    }
}

extension NoteEditorViewModel {
    /// Turns a block into `choice` and returns the step that undoes it: from
    /// snapshots when the editor can read them, otherwise the bare type change
    /// it could always record.
    func turnIntoStep(_ blockId: String, into choice: InsertableBlock, from previous: String) async
        -> EditorUndoStep
    {
        let before = await snapshot(blockId)
        await turnInto(blockId, kind: choice.id, level: choice.level)
        if let before, let after = await snapshot(blockId) {
            return .turnInto(before: before, after: after)
        }
        return .turnInto(blockId: blockId, from: previous, to: choice.id)
    }
}

/// What the menu offers for one block.
struct BlockActionTarget {
    let block: Block
    let siblings: BlockSiblings

    var blockId: String? { block.id }

    /// Desktop hides Turn into on blocks with no inline text of their own
    /// (`NON_TEXT_BLOCK_TYPES` in `block-side-menu.tsx`).
    static let textKinds: Set<String> = [
        "paragraph", "heading", "bulletListItem", "numberedListItem", "checkListItem",
        "toggleListItem", "quote", "codeBlock", "callout",
    ]

    /// Blocks whose schema carries `textColor` and `backgroundColor`: code
    /// blocks do not, and desktop offers no colours for them.
    static let colourKinds: Set<String> = textKinds.subtracting(["codeBlock"])

    var canTurnInto: Bool { Self.textKinds.contains(block.kind) }
    var canColour: Bool { Self.colourKinds.contains(block.kind) }

    func prop(_ name: String) -> String {
        block.props.first { $0.name == name }?.value ?? "default"
    }

    /// Whether `choice` is what the block already is, for the checkmark.
    func isCurrent(_ choice: InsertableBlock) -> Bool {
        guard choice.id == block.kind else { return false }
        guard let level = choice.level else { return true }
        return Int(block.props.first { $0.name == "level" }?.value ?? "1") == level
    }
}

/// The actions, applied through the session so they queue behind typing and
/// land on the undo stack.
@MainActor
struct BlockActionRunner {
    let session: EditorSession
    let target: BlockActionTarget

    private var isFocused: Bool {
        target.blockId != nil && session.focusedBlockId == target.blockId
    }

    func turnInto(_ choice: InsertableBlock) {
        if isFocused { return session.turnInto(choice) }
        guard let blockId = target.blockId else { return }
        let previous = target.block.kind
        session.runBlockAction { model in
            session.history.record(await model.turnIntoStep(blockId, into: choice, from: previous))
        }
    }

    /// `textColor` or `backgroundColor`, as desktop's side-menu colour picker
    /// writes them.
    func setColour(_ prop: String, _ name: String) {
        if isFocused { return session.setBlockColor(prop, name) }
        guard let blockId = target.blockId else { return }
        let previous = target.prop(prop)
        session.runBlockAction { model in
            await model.setProp(blockId, prop, name)
            session.history.record(.prop(blockId: blockId, name: prop, from: previous, to: name, label: "Colour"))
        }
    }

    func moveUp() {
        guard let blockId = target.blockId,
              let step = EditorUndoStep.moveUp(blockId: blockId, siblings: target.siblings) else { return }
        apply(step, refocus: isFocused)
    }

    func moveDown() {
        guard let blockId = target.blockId,
              let step = EditorUndoStep.moveDown(blockId: blockId, siblings: target.siblings) else { return }
        apply(step, refocus: isFocused)
    }

    func duplicate() {
        guard let blockId = target.blockId else { return }
        let step = EditorUndoStep.duplicate(blockId: blockId, newBlockId: UUID().uuidString.lowercased())
        apply(step)
    }

    /// Undone from a snapshot of the whole subtree read just before it. An
    /// editor with no snapshot read records no step: an undo that brought back
    /// only the block's text would lie.
    func delete() {
        guard let blockId = target.blockId else { return }
        // The keyboard goes first, so the text view's own commit is queued
        // before the delete rather than after it.
        if isFocused { session.dismissKeyboard() }
        session.runBlockAction { model in
            let snapshot = await model.snapshot(blockId)
            await model.delete(blockId)
            if let snapshot {
                session.history.record(.delete(blockId: blockId, snapshot: snapshot))
            }
        }
    }

    /// `refocus`: the caret follows a moved block, which the page redraws
    /// in another row.
    private func apply(_ step: EditorUndoStep, refocus: Bool = false) {
        let blockId = target.blockId
        session.runBlockAction { model in
            await model.apply(step.forward)
            session.history.record(step)
            if refocus { session.pendingFocus = blockId }
        }
    }
}

/// The menu's items, shared by the handle and the whole-block long press.
struct BlockActionMenuItems: View {
    let runner: BlockActionRunner

    private var target: BlockActionTarget { runner.target }

    var body: some View {
        if target.canTurnInto {
            Menu {
                ForEach(InsertableBlock.all) { choice in
                    Button {
                        runner.turnInto(choice)
                    } label: {
                        if target.isCurrent(choice) {
                            Label(choice.name, systemImage: "checkmark")
                        } else {
                            Label(choice.name, systemImage: choice.symbol)
                        }
                    }
                }
            } label: {
                Label("Turn into", systemImage: "arrow.triangle.2.circlepath")
            }
        }
        if target.canColour {
            BlockColourMenu(runner: runner, title: "Text colour", prop: "textColor", symbol: "character")
            BlockColourMenu(runner: runner, title: "Background colour", prop: "backgroundColor", symbol: "paintbrush")
        }
        Section {
            Button {
                runner.moveUp()
            } label: {
                Label("Move up", systemImage: "arrow.up")
            }
            .disabled(target.siblings.previous == nil)
            Button {
                runner.moveDown()
            } label: {
                Label("Move down", systemImage: "arrow.down")
            }
            .disabled(target.siblings.next == nil)
            Button {
                runner.duplicate()
            } label: {
                Label("Duplicate", systemImage: "plus.square.on.square")
            }
        }
        Section {
            Button(role: .destructive) {
                runner.delete()
            } label: {
                Label("Delete", systemImage: "trash")
            }
        }
    }

}

/// A block's text or background colour, in desktop's palette: the block menu
/// and the keyboard toolbar's `...` menu.
struct BlockColourMenu: View {
    let runner: BlockActionRunner
    let title: String
    /// `textColor` or `backgroundColor`.
    let prop: String
    let symbol: String

    var body: some View {
        let current = runner.target.prop(prop)
        Menu {
            // "Default" first: getting back to no colour is the choice a user
            // needs most, and desktop's picker leads with it too.
            ForEach(["default"] + Tokens.Content.names, id: \.self) { name in
                Button {
                    runner.setColour(prop, name)
                } label: {
                    if name == current {
                        Label(name.capitalized, systemImage: "checkmark")
                    } else {
                        Text(name.capitalized)
                    }
                }
            }
        } label: {
            Label(title, systemImage: symbol)
        }
    }
}

/// VoiceOver's route to the same actions: a context menu needs a long press,
/// and the actions rotor needs none.
private struct BlockActionAccessibility: ViewModifier {
    let runner: BlockActionRunner

    func body(content: Content) -> some View {
        content
            .accessibilityAction(named: "Move up") { runner.moveUp() }
            .accessibilityAction(named: "Move down") { runner.moveDown() }
            .accessibilityAction(named: "Duplicate") { runner.duplicate() }
            .accessibilityAction(named: "Delete block") { runner.delete() }
    }
}

/// Attaches the block menu to one block.
///
/// `editsInPlace` is whether the block is a text view: then the menu hangs
/// off a margin handle while the block has the caret; otherwise the whole
/// block takes the long press.
struct BlockActionsAttachment<Preview: View>: ViewModifier {
    let runner: BlockActionRunner?
    let editsInPlace: Bool
    @ViewBuilder let preview: () -> Preview

    func body(content: Content) -> some View {
        if let runner {
            if editsInPlace {
                content.overlay(alignment: .topLeading) {
                    if runner.session.focusedBlockId == runner.target.blockId {
                        BlockActionHandle(runner: runner, preview: preview)
                    }
                }
            } else {
                content
                    .contextMenu {
                        BlockActionMenuItems(runner: runner)
                    } preview: {
                        BlockActionPreview(content: preview)
                    }
                    .modifier(BlockActionAccessibility(runner: runner))
            }
        } else {
            content
        }
    }
}

/// The margin handle: desktop's drag-handle dots, in the page's leading
/// margin beside the block with the caret.
///
/// A 44pt square whose first `Space.screenInline` points sit in the margin
/// and the rest over the block's leading edge, which on every block kind is
/// a marker, a checkbox or the start of the first line rather than the middle
/// of a word.
private struct BlockActionHandle<Preview: View>: View {
    let runner: BlockActionRunner
    let preview: () -> Preview

    var body: some View {
        Image(systemName: "circle.grid.2x3.fill")
            .font(Tokens.Typography.caption.font)
            .foregroundStyle(Tokens.Text.tertiary.color)
            .frame(width: Tokens.Space.screenInline)
            .frame(
                width: Tokens.Size.minimumHitArea, height: Tokens.Size.minimumHitArea,
                alignment: .leading
            )
            .contentShape(.rect)
            .contextMenu {
                BlockActionMenuItems(runner: runner)
            } preview: {
                BlockActionPreview(content: preview)
            }
            // The handle's own leading edge goes a margin's width before the
            // block's; an alignment guide rather than an offset so it mirrors
            // in right-to-left.
            .alignmentGuide(.leading) { _ in Tokens.Space.screenInline }
            .alignmentGuide(.top) { dimension in
                // Centred on the block's first line.
                (dimension.height - UIFont.preferredFont(forTextStyle: .body).lineHeight) / 2
            }
            .accessibilityElement()
            .accessibilityLabel("Block actions")
            .accessibilityHint("Touch and hold for turn into, colours, move, duplicate and delete.")
            .modifier(BlockActionAccessibility(runner: runner))
    }
}

/// The lifted block, drawn read-only on the canvas colour.
private struct BlockActionPreview<Content: View>: View {
    let content: () -> Content

    var body: some View {
        content()
            .padding(Tokens.Space.inset)
            .frame(width: 320, alignment: .leading)
            .fixedSize(horizontal: false, vertical: true)
            .background(Tokens.Canvas.background.color)
    }
}
