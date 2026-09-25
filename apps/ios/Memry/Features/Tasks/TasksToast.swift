import MemryCore
import SwiftUI

// TP051. The toast every task write raises through `store.perform(message)`,
// with Undo when the write is undoable (desktop's sonner toast with an
// `action`, `hooks/use-undoable-task-actions.ts`, `use-bulk-actions.ts`).
//
// - It leaves after ~4 s; with VoiceOver on it stays 10 s (desktop's bulk
//   toast duration), so the Undo action can still be reached after the
//   announcement.
// - It is announced to VoiceOver; Undo is its own element after the message.
// - Under reduce motion it appears and leaves without movement.
// - Hardware Cmd+Z undoes while the Undo toast is up. Desktop lets a text
//   field keep its own Cmd+Z (`use-undo.ts`); the shell cannot see another
//   screen's focus, so the shortcut lives only as long as the toast does.

/// TP051 — the Undo toast.
struct TasksToast: View {
    let store: TasksStore

    @Environment(\.accessibilityVoiceOverEnabled) private var voiceOverEnabled

    var body: some View {
        let key = store.toastKey
        ZStack(alignment: .bottomLeading) {
            if let key {
                UndoToastCard(
                    message: key.message,
                    undoTitle: TasksCopy.undo,
                    undoHint: TasksCopy.undoHint,
                    identifier: "tasks.toast",
                    undo: store.toastUndo == nil ? nil : undoAction
                )
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .calmAnimation(.normal, value: key)
        .background { undoShortcut }
        .task(id: key) { await expire(key) }
        .onChange(of: key) { _, new in
            if let new { AccessibilityNotification.Announcement(new.message).post() }
        }
    }

    private var undoAction: () -> Void {
        { Task { await store.undoFromToast(viaKeyboard: false) } }
    }

    /// Cmd+Z, registered only while the Undo toast is up.
    @ViewBuilder private var undoShortcut: some View {
        if store.toastUndo != nil {
            Button(TasksCopy.undo) {
                Task { await store.undoFromToast(viaKeyboard: true) }
            }
            .keyboardShortcut("z", modifiers: .command)
            .opacity(0)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
        }
    }

    private func expire(_ key: TasksToastKey?) async {
        guard let key else { return }
        let seconds = voiceOverEnabled ? 10 : 4
        try? await Task.sleep(for: .seconds(seconds))
        guard !Task.isCancelled else { return }
        store.dismissToast(key)
    }
}
