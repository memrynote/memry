//
//  NoteExtras.swift
//  Export, templates and reminders.
//
//  N802, N803, N804.
//

import MemryCore
import Observation
import SwiftUI

// MARK: - N802, export

/// What a note can be exported as.
///
/// **Plain text, not markdown, and that is a protocol constraint rather than
/// a shortcut.** §12.1.2 says a non-editor client "owns `extract_text` and
/// nothing else": producing markdown would mean re-spelling the body from the
/// CRDT, and a client that guessed at the spelling would hand the user a file
/// that differs from the one desktop writes for the same note.
///
/// So the export says what it is. A file labelled `.md` whose contents are
/// flattened text would be a quiet lie.
struct NoteExport: Equatable, Sendable {
    let title: String
    let text: String

    /// The filename offered to the share sheet.
    ///
    /// Sanitised, because a note title is free text and can hold a slash,
    /// which would be a path separator rather than a character in a name.
    var filename: String {
        let cleaned = title
            .replacingOccurrences(of: "/", with: "-")
            .replacingOccurrences(of: ":", with: "-")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return (cleaned.isEmpty ? "Untitled" : cleaned) + ".txt"
    }

    /// The whole file: the title, then the body.
    var contents: String {
        title.isEmpty ? text : "\(title)\n\n\(text)"
    }
}

/// Shares a note as a text file.
struct NoteExportButton: View {
    let export: NoteExport

    var body: some View {
        ShareLink(
            item: export.contents,
            subject: Text(export.title),
            preview: SharePreview(export.filename)
        ) {
            Label("Export", systemImage: "square.and.arrow.up")
        }
        .accessibilityLabel("Export this note as text")
    }
}

// MARK: - N803, templates

/// Making a note from a template.
@MainActor
@Observable
final class TemplatePickerViewModel {
    private(set) var templates: [TemplateSummary] = []
    private(set) var failure: UserFacingError?

    private let reader: any NotesReading
    private let writer: (any NotesWriting)?

    init(reader: any NotesReading, writer: (any NotesWriting)?) {
        self.reader = reader
        self.writer = writer
    }

    var canApply: Bool { writer != nil }

    func load() async {
        do {
            templates = try await reader.templates()
        } catch {
            Log.storage.error("the templates could not be read")
            failure = ErrorMapping.userFacing(error)
        }
    }

    /// Creates a note from a template and returns its id.
    func apply(_ templateId: String, title: String, folderPath: String?) async -> String? {
        guard let writer else { return nil }
        do {
            return try await writer.createFromTemplate(
                templateId: templateId,
                title: title,
                folderPath: folderPath
            )
        } catch {
            failure = ErrorMapping.userFacing(error)
            return nil
        }
    }
}

struct TemplatePicker: View {
    let model: TemplatePickerViewModel
    /// Where the new note goes. `nil` is the vault root.
    let folderPath: String?
    let made: (String) -> Void

    @State private var title = ""

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Title", text: $title)
                        .accessibilityLabel("Title for the new note")
                }
                Section {
                    if model.templates.isEmpty {
                        Text("This vault has no templates yet.")
                            .font(Tokens.Typography.supporting.font)
                            .foregroundStyle(Tokens.Text.secondary.color)
                    } else {
                        ForEach(model.templates, id: \.id) { template in
                            Button {
                                Task {
                                    if let id = await model.apply(
                                        template.id,
                                        title: title,
                                        folderPath: folderPath
                                    ) {
                                        made(id)
                                    }
                                }
                            } label: {
                                HStack(spacing: Tokens.Space.small) {
                                    if let icon = template.icon { Text(icon) }
                                    VStack(alignment: .leading, spacing: Tokens.Space.tight) {
                                        Text(template.name)
                                            .foregroundStyle(Tokens.Text.primary.color)
                                        if let description = template.description {
                                            Text(description)
                                                .font(Tokens.Typography.caption.font)
                                                .foregroundStyle(Tokens.Text.secondary.color)
                                        }
                                    }
                                }
                            }
                            .disabled(!model.canApply)
                        }
                    }
                }
            }
            .navigationTitle("New from template")
            .task { await model.load() }
        }
    }
}

// MARK: - N804, reminders

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
                            Text(NoteInstants.label(for: reminder.remindAt))
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
