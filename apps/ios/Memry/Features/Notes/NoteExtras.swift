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

/// The tasks linked to this note, after desktop's `note/linked-tasks`: absent
/// when there are none, a collapsible "Linked Tasks (N)" header, and each row
/// opening its task (TP054) in the Tasks tab.
struct LinkedTasksSection: View {
    let model: LinkedTasksViewModel
    /// Opens a task by id. `nil` draws the rows without the action.
    var open: ((String) -> Void)?

    @State private var isCollapsed = false

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.small) {
            if !model.tasks.isEmpty {
                header
                if !isCollapsed {
                    ForEach(model.tasks, id: \.id) { task in
                        if let open {
                            Button { open(task.id) } label: { row(task) }
                                .buttonStyle(.plain)
                                .accessibilityAddTraits(.isButton)
                                .accessibilityHint(TasksCopy.openInTasks)
                                .accessibilityIdentifier("tasks.noteLinked.row")
                        } else {
                            row(task)
                        }
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .calmAnimation(.fast, value: isCollapsed)
        .task { await model.load() }
    }

    private var header: some View {
        Button {
            isCollapsed.toggle()
        } label: {
            HStack(spacing: Tokens.Space.small) {
                // Two symbols rather than a rotation: a rotated forward
                // chevron points up, not down, in right-to-left layouts.
                Image(systemName: isCollapsed ? "chevron.forward" : "chevron.down")
                    .foregroundStyle(Tokens.Text.tertiary.color)
                Text(TasksCopy.linkedTasksTitle)
                    .font(Tokens.Typography.heading.font)
                    .foregroundStyle(Tokens.Text.primary.color)
                Text("(\(model.tasks.count))")
                    .font(Tokens.Typography.caption.font)
                    .foregroundStyle(Tokens.Text.secondary.color)
                Spacer(minLength: 0)
            }
            .frame(minHeight: Tokens.Size.minimumHitArea)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(TasksCopy.linkedTasksHeader(model.tasks.count))
        .accessibilityValue(isCollapsed ? TasksCopy.linkedTasksCollapsed : TasksCopy.linkedTasksExpanded)
        .accessibilityAddTraits([.isHeader, .isButton])
        .accessibilityIdentifier("tasks.noteLinked.header")
    }

    private func row(_ task: LinkedTask) -> some View {
        HStack(spacing: Tokens.Space.small) {
            Image(systemName: task.isDone ? "checkmark.circle.fill" : "circle")
                .foregroundStyle(task.isDone ? Tokens.Task.complete.color : Tokens.Text.tertiary.color)
            VStack(alignment: .leading, spacing: Tokens.Space.tight) {
                Text(task.title)
                    .font(Tokens.Typography.body.font)
                    .foregroundStyle(task.isDone ? Tokens.Text.secondary.color : Tokens.Text.primary.color)
                    .strikethrough(task.isDone)
                // Which relationship this is, because "written here" and
                // "mentions this note" are different facts about one list.
                Text(subtitle(for: task))
                    .font(Tokens.Typography.caption.font)
                    .foregroundStyle(Tokens.Text.secondary.color)
            }
            Spacer(minLength: 0)
        }
        .frame(minHeight: Tokens.Size.minimumHitArea)
        .contentShape(.rect)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(
            TasksCopy.linkedTaskLabel(title: task.title, isDone: task.isDone, subtitle: subtitle(for: task))
        )
    }

    private func subtitle(for task: LinkedTask) -> String {
        TasksCopy.linkedTaskSubtitle(
            fromThisNote: task.fromThisNote,
            due: task.dueDate.map { TaskBlockRow.dueLabel($0) ?? $0 }
        )
    }
}
