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
        ZStack(alignment: .bottom) {
            if let key {
                TasksToastCard(message: key.message, undo: store.toastUndo == nil ? nil : undoAction)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .padding(.horizontal, Tokens.Space.inset)
        .padding(.bottom, Tokens.Space.small)
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

/// The toast's card: the message, and Undo when there is one.
private struct TasksToastCard: View {
    let message: String
    let undo: (() -> Void)?

    var body: some View {
        HStack(spacing: Tokens.Space.medium) {
            Text(message)
                .font(Tokens.Typography.supporting.font)
                .foregroundStyle(Tokens.Text.primary.color)
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("tasks.toast.message")
            if let undo {
                Button(TasksCopy.undo, action: undo)
                    .font(Tokens.Typography.label.font)
                    .foregroundStyle(Tokens.Text.primary.color)
                    .frame(minWidth: Tokens.Size.minimumHitArea, minHeight: Tokens.Size.minimumHitArea)
                    .contentShape(.rect)
                    .accessibilityHint(TasksCopy.undoHint)
                    .accessibilityIdentifier("tasks.toast.undo")
            }
        }
        .padding(.leading, Tokens.Space.inset)
        .padding(.trailing, undo == nil ? Tokens.Space.inset : Tokens.Space.small)
        .padding(.vertical, undo == nil ? Tokens.Space.medium : Tokens.Space.tight)
        .frame(minHeight: Tokens.Size.minimumHitArea)
        .blockSurface(radius: Tokens.Radius.card)
        .overlay {
            RoundedRectangle(cornerRadius: Tokens.Radius.card)
                .strokeBorder(Tokens.Line.border.color, lineWidth: Tokens.Size.hairline)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("tasks.toast")
    }
}
