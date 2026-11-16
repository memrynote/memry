//
//  EditorUndo.swift
//  N509 — undo over the operations the shell issued.
//
//  **Native, and deliberately not a yrs `UndoManager` in the core.** The core
//  has no undo stack and is not getting one: undo is a property of *this
//  user's session*, not of the document. A CRDT undo manager scoped to a
//  document would have to decide what to do about another device's
//  concurrent edits, and the honest answer for a shell is that it should not
//  try — undoing someone else's paragraph because it arrived during your
//  session is worse than having no undo.
//
//  So the stack holds what this shell did, and each entry knows the operation
//  that reverses it.
//

import Foundation
import MemryCore

/// One reversible step: what was done, and what undoes it.
///
/// Both directions are stored rather than derived, because deriving the
/// inverse of an operation needs the document as it was *before* it ran, and
/// by the time undo is pressed that document is gone.
struct EditorUndoStep: Sendable, Equatable {
    /// What the user did, in words, for the undo affordance's label.
    let name: String
    /// The operation that puts the document back.
    let backward: BlockEdit
    /// The operation that does it again.
    let forward: BlockEdit
    /// Replayed after `forward`: the props an inserted block carries, which
    /// `InsertBlock` alone cannot write, or the inline nodes typing put in,
    /// which `ReplaceText` cannot.
    var forwardProps: [BlockEdit] = []
    /// Replayed after `forward`, before `forwardProps`: the nodes that
    /// replaced text the typing wrote, a typed `[[link]]` or a `#tag`. Each
    /// goes over its literal where the block holds it once `forward` lands
    /// (`NoteEditorViewModel.insert(_:over:typedLength:)`), not at its
    /// recorded offsets: another pane may have typed before it since
    /// (#4377).
    var forwardOverText: [TextNode] = []
    /// `forward`'s text in core bytes, which each `TextNode.start` counts in.
    var forwardLength = 0
    /// Where a redo leaves the caret, in UTF-16 of the block it draws: after
    /// the nodes it put back. The redraw's own guess lands before a node
    /// put back beside an equal one.
    var caret: Int?
    /// Replayed after `backward`: a step that changed two blocks, such as a
    /// merge, puts both back.
    var backwardAfter: [BlockEdit] = []
    /// A date chip rewritten under its anchor (#4762). Undo and redo run
    /// this instead of `backward` and `forward`, which hold the node writes
    /// at the pane's offsets: each finds the chip where the block holds it
    /// then (`NoteEditorViewModel.rewriteDate`).
    var date: DateRewrite?

    struct DateRewrite: Sendable, Equatable {
        let blockId: String
        let chip: DateChipAnchor
        let from: DateMentionValue
        let to: DateMentionValue
    }

    /// An inline node over text: `edit` replaced `literal`, which starts
    /// `start` core bytes into the text the typing wrote.
    struct TextNode: Sendable, Equatable {
        let start: Int
        let literal: String
        let edit: BlockEdit
    }
}

/// This session's undo history.
///
/// **Bounded on purpose.** An unbounded stack on a long editing session is a
/// slow memory leak that only shows up on the devices least able to afford
/// it.
@MainActor
@Observable
final class EditorUndoStack {
    private(set) var undoable: [EditorUndoStep] = []
    private(set) var redoable: [EditorUndoStep] = []

    /// How many steps are kept. Desktop's own history is not unbounded
    /// either.
    private let limit: Int

    init(limit: Int = 100) {
        self.limit = limit
    }

    var canUndo: Bool { !undoable.isEmpty }
    var canRedo: Bool { !redoable.isEmpty }

    /// The label for the undo affordance, so it says what it will undo rather
    /// than just "Undo".
    var undoName: String? { undoable.last?.name }
    var redoName: String? { redoable.last?.name }

    /// Records a step the user just performed.
    ///
    /// **Recording clears the redo stack**, because the future that redo
    /// pointed at no longer follows from the present. A redo that replayed an
    /// operation onto a document that had since diverged would apply to the
    /// wrong blocks.
    func record(_ step: EditorUndoStep) {
        undoable.append(step)
        redoable.removeAll()
        if undoable.count > limit {
            undoable.removeFirst(undoable.count - limit)
        }
    }

    /// Takes the next step to undo, moving it onto the redo stack.
    func popUndo() -> EditorUndoStep? {
        guard let step = undoable.popLast() else { return nil }
        redoable.append(step)
        return step
    }

    /// Puts a step on the redo stack without doing it: undone typing that the
    /// next undo would otherwise strand (`EditorSession.undo`). The typing
    /// was a new edit, so the steps redo held from before it go, as
    /// `record` drops them.
    func keepRedo(_ step: EditorUndoStep) {
        redoable = [step]
    }

    func popRedo() -> EditorUndoStep? {
        guard let step = redoable.popLast() else { return nil }
        undoable.append(step)
        return step
    }

    /// Forgets everything.
    ///
    /// Called when the note is closed: a stack that outlived its note would
    /// undo into a document the user is no longer looking at.
    func clear() {
        undoable.removeAll()
        redoable.removeAll()
    }
}

extension EditorUndoStep {
    /// The step for a text change, which is the common one: `ReplaceText`
    /// both ways, each carrying the text it starts from as its `base`.
    ///
    /// The core then applies only this step's own change to the live block,
    /// in place, keeping marks and inline nodes. Another pane on the note
    /// (#4377) or a peer may have typed in the block since: undo takes back
    /// `next` to `previous` and redo puts it again, and their typing stays.
    static func text(blockId: String, from previous: String, to next: String) -> EditorUndoStep {
        EditorUndoStep(
            name: "Typing",
            backward: .replaceText(blockId: blockId, text: previous, base: next),
            forward: .replaceText(blockId: blockId, text: next, base: previous)
        )
    }

    /// Typing whose commit then put inline nodes in: a typed `[[link]]`, a
    /// menu's or a drop's link or date. `next` is the block as the step left
    /// it, each node a U+FFFC, then with each node in turn back as text
    /// (`BlockText.placingNodes`): undo walks it, so each diff takes back
    /// exactly its node and never one beside it, and ends at `previous`.
    /// A U+FFFC in `ReplaceText` makes no node, so redo writes the
    /// typing, `typed` (`typedLength` core bytes), then puts `overText` back
    /// over their literals and runs `nodes` again as they went in.
    static func text(
        blockId: String, from previous: String, typed: String, typedLength: Int,
        overText: [TextNode], nodes: [BlockEdit], to next: [String], caret: Int
    ) -> EditorUndoStep {
        let texts = next + [previous]
        let back = zip(texts, texts.dropFirst()).map { BlockEdit.replaceText(blockId: blockId, text: $1, base: $0) }
        return EditorUndoStep(
            name: "Typing",
            backward: back[0],
            forward: .replaceText(blockId: blockId, text: typed, base: previous),
            forwardProps: nodes,
            forwardOverText: overText,
            forwardLength: typedLength,
            caret: caret,
            backwardAfter: Array(back.dropFirst())
        )
    }

    /// A date chip's sheet edit: undo puts `from` back under the chip's
    /// anchor, redo `to`.
    static func date(
        blockId: String, chip: DateChipAnchor, from previous: DateMentionValue, to next: DateMentionValue
    ) -> EditorUndoStep {
        let range = chip.place.paneRange
        let node = { (value: DateMentionValue) in
            BlockEdit.insertInline(
                blockId: blockId, start: UInt32(range.lowerBound), end: UInt32(range.upperBound),
                kind: "dateMention", text: "", attrs: value.attrs(anchorId: chip.anchorId)
            )
        }
        return EditorUndoStep(
            name: "Date", backward: node(previous), forward: node(next),
            date: DateRewrite(blockId: blockId, chip: chip, from: previous, to: next)
        )
    }

    /// The step for a prop change.
    static func prop(
        blockId: String, name: String, from previous: String, to next: String, label: String
    ) -> EditorUndoStep {
        EditorUndoStep(
            name: label,
            backward: .setProp(blockId: blockId, name: name, value: previous),
            forward: .setProp(blockId: blockId, name: name, value: next)
        )
    }

    /// The step for an insert: undone by deleting what was inserted.
    static func insert(blockId: String, after: String?, kind: String, text: String)
        -> EditorUndoStep
    {
        EditorUndoStep(
            name: "Insert block",
            backward: .delete(blockId: blockId),
            forward: .insertBlock(
                kind: kind, afterBlockId: after, text: text, newBlockId: blockId
            )
        )
    }

    /// The step for a type change.
    static func turnInto(blockId: String, from previous: String, to next: String)
        -> EditorUndoStep
    {
        EditorUndoStep(
            name: "Turn into",
            backward: .turnInto(blockId: blockId, kind: previous),
            forward: .turnInto(blockId: blockId, kind: next)
        )
    }

    /// The step for a mark applied over a range.
    static func mark(blockId: String, start: Int, end: Int, mark: String, value: String?)
        -> EditorUndoStep
    {
        EditorUndoStep(
            name: "Formatting",
            backward: .removeMark(
                blockId: blockId, start: UInt32(start), end: UInt32(end), mark: mark
            ),
            forward: .setMark(
                blockId: blockId, start: UInt32(start), end: UInt32(end), mark: mark,
                value: value
            )
        )
    }
}
