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

    func add(at date: Date, title: String?) async {
        guard let writer else { return }
        do {
            _ = try await writer.addReminder(
                noteId: noteId,
                remindAt: NoteInstants.string(from: date),
                title: title
            )
            await load()
        } catch {
            failure = ErrorMapping.userFacing(error)
        }
    }

    func dismiss(_ id: String) async {
        guard let writer else { return }
        do {
            try await writer.dismissReminder(id: id)
            await load()
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
            await load()
        } catch {
            failure = ErrorMapping.userFacing(error)
        }
    }
}

struct NoteRemindersSection: View {
    let model: NoteRemindersViewModel

    @State private var adding = false
    @State private var when = Date()

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.small) {
            HStack {
                Text("Reminders")
                    .font(Tokens.Typography.heading.font)
                    .foregroundStyle(Tokens.Text.primary.color)
                Spacer()
                if model.canWrite {
                    Button {
                        adding = true
                    } label: {
                        Image(systemName: "plus")
                    }
                    .accessibilityLabel("Add a reminder")
                }
            }

            if model.live.isEmpty {
                Text("Nothing is set to remind you about this note.")
                    .font(Tokens.Typography.supporting.font)
                    .foregroundStyle(Tokens.Text.secondary.color)
            } else {
                ForEach(model.live, id: \.id) { reminder in
                    HStack {
                        VStack(alignment: .leading, spacing: Tokens.Space.tight) {
                            Text(reminder.title ?? "Reminder")
                                .font(Tokens.Typography.body.font)
                                .foregroundStyle(Tokens.Text.primary.color)
                            // An anchored `note_date` reminder carries no
                            // instant on the wire: each device derives it
                            // from the date pill it belongs to
                            // (`reminder-handler.ts`). Said in words rather
                            // than left as an empty line.
                            Text(reminder.remindAt.isEmpty
                                ? "Set by a date in this note"
                                : NoteInstants.label(for: reminder.remindAt))
                                .font(Tokens.Typography.caption.font)
                                .foregroundStyle(Tokens.Text.secondary.color)
                        }
                        Spacer()
                        if model.canWrite {
                            Button("Dismiss") {
                                Task { await model.dismiss(reminder.id) }
                            }
                            .font(Tokens.Typography.caption.font)
                        }
                    }
                    .accessibilityElement(children: .combine)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .task { await model.load() }
        .sheet(isPresented: $adding) {
            NavigationStack {
                Form {
                    DatePicker("Remind me at", selection: $when)
                }
                .navigationTitle("Add a reminder")
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        Button("Cancel") { adding = false }
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("Add") {
                            adding = false
                            Task { await model.add(at: when, title: nil) }
                        }
                    }
                }
            }
        }
    }
}
