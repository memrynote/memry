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
    /// The step for a text change, which is the common one.
    ///
    /// Both directions are a `SetText`, which makes text undo exact rather
    /// than approximate.
    static func text(blockId: String, from previous: String, to next: String) -> EditorUndoStep {
        EditorUndoStep(
            name: "Typing",
            backward: .setText(blockId: blockId, text: previous),
            forward: .setText(blockId: blockId, text: next)
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
