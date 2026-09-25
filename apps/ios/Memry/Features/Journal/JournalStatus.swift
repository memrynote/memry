import SwiftUI

// JP092. How the Journal says a read or write failed, and its confirmations:
// the store's `failure` and `toast`, which every Journal screen shares.

/// A calendar screen's body before its record arrives: the error with a
/// retry once a read failed, the spinner until then.
struct JournalLoadState: View {
    let store: JournalStore
    let retry: () async -> Void

    var body: some View {
        Group {
            if let failure = store.failure {
                VStack(alignment: .leading, spacing: Tokens.Space.small) {
                    ErrorNotice(error: failure, code: nil)
                    Button(JournalCopy.tryAgain) {
                        store.clearFailure()
                        Task { await retry() }
                    }
                    .memrySecondaryAction()
                }
            } else {
                ProgressView(JournalCopy.loading)
                    .frame(maxWidth: .infinity)
            }
        }
        .padding(.top, Tokens.Space.section)
    }
}

/// A failed write on the Day screen, over the page until dismissed.
struct JournalFailureBanner: View {
    let store: JournalStore

    var body: some View {
        if let failure = store.failure {
            HStack(alignment: .top, spacing: Tokens.Space.small) {
                ErrorNotice(error: failure, code: nil)
                Button(JournalCopy.dismiss, systemImage: "xmark") { store.clearFailure() }
                    .labelStyle(.iconOnly)
                    .frame(minWidth: Tokens.Size.minimumHitArea, minHeight: Tokens.Size.minimumHitArea)
            }
            .padding(.horizontal, Tokens.Space.screenInline)
            .background(Tokens.Canvas.background.color)
        }
    }
}

/// The store's confirmation ("Reminder set"), the Tasks toast's capsule
/// without Undo, cleared after its time on screen.
struct JournalToast: View {
    let store: JournalStore

    @Environment(\.accessibilityVoiceOverEnabled) private var voiceOverEnabled

    var body: some View {
        let message = store.toast
        ZStack(alignment: .bottomLeading) {
            if let message {
                TasksToastCard(message: message, undo: nil)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .calmAnimation(.normal, value: message)
        .task(id: message) { await expire(message) }
        .onChange(of: message) { _, new in
            if let new { AccessibilityNotification.Announcement(new).post() }
        }
    }

    private func expire(_ message: String?) async {
        guard let message else { return }
        try? await Task.sleep(for: .seconds(voiceOverEnabled ? 10 : 4))
        guard !Task.isCancelled, store.toast == message else { return }
        store.toast = nil
    }
}

/// The Tasks store's subtask and repeat prompts, bound once for the Journal.
struct JournalSubtaskPrompts: ViewModifier {
    let tasks: TasksStore?

    func body(content: Content) -> some View {
        if let tasks {
            content.subtaskPrompts(store: tasks)
        } else {
            content
        }
    }
}
