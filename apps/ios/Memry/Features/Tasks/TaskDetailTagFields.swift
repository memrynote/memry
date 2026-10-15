import MemryCore
import SwiftUI

// #3310. The task's tag fields under the Tags row, after desktop's
// `TaskFieldGroups` in the task drawer: per tag, the fields its schema lists,
// each value edited in place. Values only: a field is defined on desktop. A
// value lives in the task's versioned `fields` map (§13.7.3.1), which the core
// reads and stamps, so the note view's section draws it through a writer that
// targets the task.

struct TaskDetailTagFields: View {
    let task: TaskItem
    let store: TasksStore

    @Environment(\.vaultBrowse) private var browse
    @State private var groups: [TagFieldGroup] = []
    @State private var notes: [NoteSummary] = []
    @State private var model: NoteMetadataViewModel?

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.small) {
            if let model, !groups.isEmpty {
                if case let .failed(error) = model.status {
                    ErrorNotice(error: error, code: nil)
                }
                NoteTagFieldsSection(
                    groups: groups,
                    model: model,
                    reload: load,
                    noteTitle: { id in notes.first { $0.id == id }?.title },
                    noteIcon: { id in ProjectIconValue.emoji(notes.first { $0.id == id }?.emoji) },
                    relationCandidates: notes
                )
                .padding(.vertical, Tokens.Space.small)
            }
        }
        // The task's tags decide the groups; a sync pass refreshes the item.
        .task(id: task) { await load() }
    }

    private func load() async {
        if model == nil {
            let made = NoteMetadataViewModel(noteId: task.id, writer: TaskFieldValueWriter(core: store.core))
            made.requestSync = { [store] in store.scheduleSync() }
            model = made
        }
        let id = task.id
        groups = await store.read { try $0.tagFields(id: id) } ?? []
        let needsNotes = groups.contains { $0.fields.contains { $0.property.typeName == "relation" } }
        if needsNotes, notes.isEmpty, let reader = browse?.reader {
            do {
                notes = try await reader.list()
            } catch {
                Log.storage.error("the notes for a relation field did not load")
            }
        }
    }
}

/// The note section's writer, aimed at one task's field values. Only a value
/// write reaches here; anything else the section cannot ask of a task.
private struct TaskFieldValueWriter: NoteMetadataWriting {
    let core: any TasksProtocol

    func setProperty(id: String, name: String, valueJson: String) async throws {
        try await write(id, name, valueJson)
    }

    func clearProperty(id: String, name: String) async throws {
        try await write(id, name, nil)
    }

    private func write(_ id: String, _ name: String, _ valueJson: String?) async throws {
        let core = core
        _ = try await CoreExecutor.shared.run {
            try core.setFieldValue(id: id, name: name, valueJson: valueJson)
        }
    }

    func rename(id: String, title: String) async throws { throw NoteMetadataWriteUnsupported() }
    func setIcon(id: String, icon: String?) async throws { throw NoteMetadataWriteUnsupported() }
    func setTags(id: String, tags: [String]) async throws { throw NoteMetadataWriteUnsupported() }
    func setCover(id: String, url: String?, offsetY: Double) async throws { throw NoteMetadataWriteUnsupported() }
    func setAliases(id: String, aliases: [String]) async throws { throw NoteMetadataWriteUnsupported() }
}
