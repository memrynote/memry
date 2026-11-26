import MemryCore
import Observation
import SwiftUI

// A note's reminders (N804), split from `NoteExtras.swift`.

/// Instants, as a reminder carries them.
enum NoteInstants {
    /// ISO 8601 with milliseconds, in UTC.
    ///
    /// **A reminder is an instant, not a calendar day**, which is why this
    /// differs from `NoteDates`: a reminder fires at a moment and the moment
    /// is the same everywhere, so UTC is right here and wrong there.
    /// `ISO8601FormatStyle` rather than `ISO8601DateFormatter`, because the
    /// formatter is a class with mutable state and is not `Sendable`: a
    /// shared static one is a data race the compiler refuses, and making it
    /// main-actor-bound would drag every caller onto the main actor for a
    /// string conversion.
    static let style = Date.ISO8601FormatStyle(
        includingFractionalSeconds: true,
        timeZone: TimeZone(secondsFromGMT: 0) ?? .gmt
    )

    static func string(from date: Date) -> String { date.formatted(style) }
    static func date(from text: String) -> Date? { try? style.parse(text) }

    /// How a reminder's instant reads on screen, in the reader's own zone.
    static func label(for text: String) -> String {
        guard let date = date(from: text) else { return text }
        return date.formatted(date: .abbreviated, time: .shortened)
    }
}

/// One note's reminders.
@MainActor
@Observable
final class NoteRemindersViewModel {
    private(set) var reminders: [ReminderSummary] = []
    private(set) var failure: UserFacingError?
    /// The add sheet, raised from the page menu.
    var adding = false

    /// The vault's debounced sync request, asked after every write that
    /// lands. Set by `NotePageSync`.
    @ObservationIgnored var requestSync: (@MainActor () -> Void)?

    private let noteId: String
    private let reader: any NotesReading
    private let writer: (any NotesWriting)?

    init(noteId: String, reader: any NotesReading, writer: (any NotesWriting)?) {
        self.noteId = noteId
        self.reader = reader
        self.writer = writer
    }

    var canWrite: Bool { writer != nil }

    /// The ones still worth showing: a dismissed reminder is history.
    var live: [ReminderSummary] {
        reminders.filter { $0.status != "dismissed" }
    }

    func load() async {
        do {
            reminders = try await reader.reminders(noteId: noteId)
        } catch {
            Log.storage.error("this note's reminders could not be read")
            failure = ErrorMapping.userFacing(error)
        }
    }

    private func wrote() async {
        requestSync?()
        await load()
    }

    func add(at date: Date, title: String?) async {
        guard let writer else { return }
        do {
            _ = try await writer.addReminder(
                noteId: noteId,
                remindAt: NoteInstants.string(from: date),
                title: title
            )
            Telemetry.shared.track(.reminderCreated, surface: .notes, action: "created", source: "custom")
            await wrote()
        } catch {
            failure = ErrorMapping.userFacing(error)
        }
    }

    func dismiss(_ id: String) async {
        guard let writer else { return }
        do {
            try await writer.dismissReminder(id: id)
            await wrote()
        } catch {
            failure = ErrorMapping.userFacing(error)
        }
    }

    func snooze(_ id: String, until date: Date) async {
        guard let writer else { return }
        do {
            try await writer.snoozeReminder(
                id: id,
                until: NoteInstants.string(from: date)
            )
            await wrote()
        } catch {
            failure = ErrorMapping.userFacing(error)
        }
    }
}

/// One live reminder in the connections card: its title and when it fires.
/// Dismiss sits in the row's context menu and its accessibility actions.
struct NoteReminderRow: View {
    let model: NoteRemindersViewModel
    let reminder: ReminderSummary

    var body: some View {
        ConnectionRow(
            symbol: "bell",
            tint: Tokens.Task.tokenTag.color,
            title: reminder.title ?? "Reminder",
            // An anchored `note_date` reminder carries no instant on the
            // wire: each device derives it from the date pill it belongs to
            // (`reminder-handler.ts`). Said in words rather than left as an
            // empty line.
            detail: reminder.remindAt.isEmpty
                ? "Set by a date in this note"
                : NoteInstants.label(for: reminder.remindAt)
        )
        .accessibilityElement(children: .combine)
        .contextMenu {
            if model.canWrite {
                Button("Dismiss", systemImage: "bell.slash", action: dismiss)
            }
        }
        .accessibilityActions {
            if model.canWrite { Button("Dismiss", action: dismiss) }
        }
    }

    private func dismiss() {
        Task { await model.dismiss(reminder.id) }
    }
}

/// The add sheet, raised from the page menu. Attached whether or not the note
/// has a reminder yet, since the first one is added through it.
struct NoteReminderAddSheet: ViewModifier {
    let model: NoteRemindersViewModel?

    @State private var when = Date()

    func body(content: Content) -> some View {
        if let model {
            content.sheet(isPresented: Bindable(model).adding) { sheet(model) }
        } else {
            content
        }
    }

    private func sheet(_ model: NoteRemindersViewModel) -> some View {
        NavigationStack {
            Form {
                DatePicker("Remind me at", selection: $when)
            }
            .navigationTitle("Add a reminder")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { model.adding = false }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Add") {
                        model.adding = false
                        Task { await model.add(at: when, title: nil) }
                    }
                }
            }
        }
    }
}
