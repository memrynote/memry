import Foundation
import MemryCore

// TP051. What the toast shows and how Undo is spoken, kept off the view so a
// test can assert it over the real store.

/// One appearance of the toast. Two writes with the same words ("Task
/// completed!" twice) are two appearances, so the change is part of the key
/// and the dismissal timer restarts.
struct TasksToastKey: Hashable, Sendable {
    let message: String
    let change: TaskChange?
}

extension TasksStore {
    /// The toast on screen now, or `nil`.
    var toastKey: TasksToastKey? {
        guard let toast else { return nil }
        return TasksToastKey(message: toast, change: toastUndo?.change)
    }

    /// The undoable change behind the toast on screen. A toast raised without
    /// a write ("All selected tasks are already complete") carries none, so
    /// it shows no Undo button.
    var toastUndo: TasksUndo? {
        guard let toast, let undoable, undoable.message == toast else { return nil }
        return undoable
    }

    /// Undo from the toast's button or hardware Cmd+Z, then confirm it in the
    /// toast: "Changes undone" for the button, "Undone: …" for the keyboard,
    /// as desktop words each.
    func undoFromToast(viaKeyboard: Bool) async {
        guard let undoable else { return }
        let description = undoable.message
        await undo()
        guard failure == nil else { return }
        toast = viaKeyboard ? TasksCopy.undone(description) : TasksCopy.changesUndone
    }

    /// Clears a toast after its time on screen, unless a newer one replaced
    /// it meanwhile.
    func dismissToast(_ key: TasksToastKey) {
        if toastKey == key { toast = nil }
    }
}
