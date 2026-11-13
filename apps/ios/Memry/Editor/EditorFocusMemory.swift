//
//  EditorFocusMemory.swift
//  #4457: the caret survives its page being drawn again.
//
//  An iPad window that crosses compact and regular width re-hosts its tab
//  content: the Notes tab swaps the split view for the phone stack, and the
//  note page is drawn again, often as a new page with a new session. The
//  focused text view leaves the window, UIKit ends its editing, and its
//  typing is committed (`textViewDidEndEditing`), but the caret was lost.
//  The block that had it and its selection are kept here for a moment, and
//  the same note's block takes them back when it is drawn into a window.
//

import Foundation
import UIKit

/// The caret of a focused block that left the window with its page.
@MainActor
final class EditorFocusMemory {
    /// One scene, one memory (`UIApplicationSupportsMultipleScenes` is false).
    static let shared = EditorFocusMemory()

    struct Caret {
        let id = UUID()
        let noteId: String
        let blockId: String
        let selection: NSRange
        /// Every write queued before the block left, its own typing last:
        /// the page drawn again may have read the note before they landed.
        let writes: Task<Void, Never>?
        let left: Date
    }

    /// A re-hosted page draws its blocks once the note is read again. A block
    /// drawn later than this is a page the user came back to, not a re-host.
    static let lifetime: TimeInterval = 3
    /// Seam for tests.
    var now: () -> Date = Date.init
    private var caret: Caret?

    func remember(noteId: String, blockId: String, selection: NSRange, writes: Task<Void, Never>?) {
        caret = Caret(noteId: noteId, blockId: blockId, selection: selection, writes: writes, left: now())
    }

    /// The remembered caret for `noteId`, until it expires.
    func caret(in noteId: String) -> Caret? {
        guard let caret, caret.noteId == noteId else { return nil }
        guard now().timeIntervalSince(caret.left) <= Self.lifetime else {
            self.caret = nil
            return nil
        }
        return caret
    }

    func holds(_ caret: Caret) -> Bool {
        self.caret?.id == caret.id
    }

    /// A new note's title takes the caret when it appears, unless one of the
    /// note's blocks is about to take back the caret it had.
    func titleMayAutofocus(_ noteId: String) -> Bool {
        caret(in: noteId) == nil
    }

    /// The caret went where the user put it: nothing is restored over it.
    func forget() {
        caret = nil
    }
}

extension EditorSession {
    /// `field` stopped editing. A text view leaving its window resigns first,
    /// in the same turn (`didMoveToWindow`), so what it had is held only
    /// until that turn ends.
    func editingEnded(_ field: BlockField, selection: NSRange) {
        endedField = (field, selection)
        DispatchQueue.main.async { [weak self, weak field] in
            if let self, self.endedField?.field === field { self.endedField = nil }
        }
    }

    /// `field`'s text view moved into a window, or out of one.
    func field(_ field: BlockField, movedInto window: UIWindow?) {
        if window == nil {
            guard let ended = endedField, ended.field === field, let noteId else { return }
            endedField = nil
            focusMemory.remember(noteId: noteId, blockId: field.blockId, selection: ended.selection, writes: tail)
        } else {
            restoreFocus(field)
        }
    }

    /// Puts the remembered caret back in `field` once the writes queued
    /// before it left have landed and the page has read them. Only the same
    /// note's same block takes it, and only while nothing else has taken the
    /// caret since.
    private func restoreFocus(_ field: BlockField) {
        guard let noteId, let caret = focusMemory.caret(in: noteId),
              caret.blockId == field.blockId, !restoringFocus
        else { return }
        restoringFocus = true
        enqueue { [weak self, weak field] in
            await caret.writes?.value
            guard let self else { return }
            await self.reload()
            self.restoringFocus = false
            guard self.focusMemory.holds(caret) else { return }
            self.focusMemory.forget()
            guard let field, field.blockId == caret.blockId, field.textView.window != nil,
                  self.focusedBlockId == nil
            else { return }
            let textView = field.textView
            textView.becomeFirstResponder()
            let length = textView.textStorage.length
            let location = min(caret.selection.location, length)
            textView.selectedRange = NSRange(location: location, length: min(caret.selection.length, length - location))
            // The page may draw the landed typing after this turn: its render
            // puts the whole selection back.
            if NSMaxRange(caret.selection) > length { field.pendingSelection = caret.selection }
        }
    }
}
