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

// MARK: - N807, the tasks linked to this note

/// The tasks a note is linked to.
@MainActor
@Observable
final class LinkedTasksViewModel {
    private(set) var tasks: [LinkedTask] = []

    private let noteId: String
    private let reader: any NotesReading

    init(noteId: String, reader: any NotesReading) {
        self.noteId = noteId
        self.reader = reader
    }

    func load() async {
        do {
            tasks = try await reader.linkedTasks(noteId: noteId)
        } catch {
            // A section that cannot load is smaller than a note that cannot
            // open, so this stays empty rather than failing the screen.
            Log.storage.error("this note's linked tasks could not be read")
            tasks = []
        }
    }
}

struct LinkedTasksSection: View {
    let model: LinkedTasksViewModel

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.small) {
            Text("Tasks")
                .font(Tokens.Typography.heading.font)
                .foregroundStyle(Tokens.Text.primary.color)

            if model.tasks.isEmpty {
                Text("No task is linked to this note.")
                    .font(Tokens.Typography.supporting.font)
                    .foregroundStyle(Tokens.Text.secondary.color)
            } else {
                ForEach(model.tasks, id: \.id) { task in
                    HStack(spacing: Tokens.Space.small) {
                        Image(systemName: task.isDone ? "checkmark.circle.fill" : "circle")
                            .foregroundStyle(Tokens.Text.secondary.color)
                        VStack(alignment: .leading, spacing: Tokens.Space.tight) {
                            Text(task.title)
                                .font(Tokens.Typography.body.font)
                                .foregroundStyle(Tokens.Text.primary.color)
                                .strikethrough(task.isDone)
                            // Which relationship this is, because "written
                            // here" and "mentions this note" are different
                            // facts about the same list.
                            Text(subtitle(for: task))
                                .font(Tokens.Typography.caption.font)
                                .foregroundStyle(Tokens.Text.secondary.color)
                        }
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel(
                        "\(task.title), \(task.isDone ? "done" : "not done"), "
                            + subtitle(for: task)
                    )
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .task { await model.load() }
    }

    private func subtitle(for task: LinkedTask) -> String {
        let origin = task.fromThisNote ? "Written in this note" : "Mentions this note"
        guard let due = task.dueDate else { return origin }
        return "\(origin) · due \(due)"
    }
}
