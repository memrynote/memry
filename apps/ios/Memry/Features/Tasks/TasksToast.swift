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
                TasksToastCard(message: key.message, undo: store.toastUndo == nil ? nil : undoAction)
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

/// The toast's capsule (Paper artboard 15): a dark glass capsule with a check,
/// the message, and Undo in a lighter capsule when there is one.
///
/// It is drawn in the dark palette in both appearances, so it reads as a
/// transient layer over the canvas; every colour inside is a token's dark
/// half, which is what `DesignTokensTests` measures for contrast. (The dark
/// halves are read directly: an `AdaptiveColor` resolves through UIKit's
/// trait collection, which a SwiftUI `colorScheme` override does not reach.)
struct TasksToastCard: View {
    let message: String
    let undo: (() -> Void)?

    private static func dark(_ color: AdaptiveColor) -> Color { Color(uiColor: color.dark.uiColor) }

    var body: some View {
        HStack(spacing: Tokens.Space.small) {
            Image(systemName: "checkmark.circle.fill")
                .font(Tokens.Typography.supporting.font)
                .foregroundStyle(Self.dark(Tokens.Task.complete))
                .accessibilityHidden(true)
            Text(message)
                .font(Tokens.Typography.supporting.font)
                .foregroundStyle(Self.dark(Tokens.Text.primary))
                .lineLimit(3)
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("tasks.toast.message")
            if let undo {
                Button(action: undo) {
                    Text(TasksCopy.undo)
                        .font(Tokens.Typography.supporting.font.weight(.semibold))
                        .foregroundStyle(Self.dark(Tokens.Text.tint))
                        .padding(.horizontal, Tokens.Space.medium)
                        .frame(minHeight: Tokens.Size.pill)
                        .background(Self.dark(Tokens.Text.primary).opacity(Tokens.Palette.chipFillAlpha), in: .capsule)
                        .frame(minWidth: Tokens.Size.minimumHitArea, minHeight: Tokens.Size.minimumHitArea)
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityHint(TasksCopy.undoHint)
                .accessibilityIdentifier("tasks.toast.undo")
            }
        }
        .padding(.leading, Tokens.Space.inset)
        .padding(.trailing, undo == nil ? Tokens.Space.inset : Tokens.Space.tight)
        .frame(minHeight: Tokens.Size.minimumHitArea + Tokens.Space.tight)
        .taskGlass(in: .capsule, tint: Self.dark(Tokens.Canvas.surfaceActive))
        .environment(\.colorScheme, .dark)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("tasks.toast")
    }
}
