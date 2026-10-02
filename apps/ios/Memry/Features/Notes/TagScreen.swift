//
//  TagScreen.swift
//  N600 — the screen a `#tag` leads to, and the list of every tag.
//
//  A tag's page is desktop's folder view scoped to a tag (`tab-content.tsx`,
//  `case 'tag'`): the folder screen's rows, sort and date grouping over the
//  tag's notes, a "+" for a note carrying the tag, and desktop's tag menu
//  (`tag-overflow-menu.tsx`: rename, colour, delete) plus Settings' merge.
//  The tag writes are Settings' own (core `tag_admin`, `TagsScreen`): each
//  rewrites every item carrying the tag and syncs.
//

import MemryCore
import Observation
import SwiftUI

/// A route to one tag's notes, so a tap can push onto the same stack a wiki
/// link pushes onto.
struct TagRoute: Hashable, Codable, Sendable {
    let name: String
}

/// A route to every tag, from the Notes root's Tags section.
struct TagListRoute: Hashable, Codable, Sendable {}

/// One tag's notes.
@MainActor
@Observable
final class TaggedNotesViewModel {
    enum Phase: Equatable {
        case loading
        case ready([NoteSummary])
        case failed(UserFacingError)
    }

    /// Changes when the tag is renamed or merged away from this page.
    var tag: String
    private let reader: any NotesReading
    private(set) var phase: Phase = .loading
    private var hasLoaded = false

    init(tag: String, reader: any NotesReading) {
        self.tag = tag
        self.reader = reader
    }

    func loadIfNeeded() async {
        guard !hasLoaded else { return }
        hasLoaded = true
        await load()
    }

    /// Re-reads when the screen comes back or the tag changed, so a note
    /// tagged or untagged in the meantime shows. Quiet: a failed read keeps
    /// what was there.
    func refresh() async {
        guard case .ready = phase, let notes = try? await reader.notesTagged(tag) else { return }
        phase = .ready(notes)
    }

    private func load() async {
        do {
            phase = .ready(try await reader.notesTagged(tag))
        } catch {
            Log.storage.error("a tag's notes could not be read")
            phase = .failed(ErrorMapping.userFacing(error))
        }
    }
}

/// Every tag in the vault, most used first, with a search field.
struct TagListView: View {
    let browse: VaultBrowseViewModel
    @State private var query = ""

    private var filtered: [TagSummary] {
        query.isEmpty ? browse.tags : browse.tags.filter { $0.name.localizedCaseInsensitiveContains(query) }
    }

    var body: some View {
        Group {
            if browse.tags.isEmpty {
                // The truth about this vault, not a shrug.
                ContentUnavailableView {
                    Label("No tags", systemImage: "number")
                } description: {
                    Text("No note here carries a tag yet.")
                }
            } else if filtered.isEmpty {
                ContentUnavailableView.search(text: query)
            } else {
                List {
                    ForEach(filtered, id: \.name) { tag in
                        NavigationLink(value: TagRoute(name: tag.name)) {
                            HStack(spacing: Tokens.Space.small) {
                                Chip(text: tag.name, color: Tokens.Palette.color(tag.color, tag: tag.name), symbol: "#")
                                Spacer(minLength: Tokens.Space.tight)
                                Text(tag.noteCount.formatted())
                                    .font(Tokens.Typography.caption.font.monospacedDigit())
                                    .foregroundStyle(Tokens.Text.tertiary.color)
                            }
                            .padding(.horizontal, Tokens.Space.small)
                            .frame(minHeight: Tokens.Size.minimumHitArea)
                        }
                        .navigationLinkIndicatorVisibility(.hidden)
                        // One phrase rather than two elements, so VoiceOver
                        // reads "research, 12 notes" and not "research" then
                        // a bare number.
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel(
                            "\(tag.name), \(tag.noteCount) \(tag.noteCount == 1 ? "note" : "notes")"
                        )
                        .shortcutRow()
                    }
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
                .environment(\.defaultMinListRowHeight, Tokens.Size.minimumHitArea)
            }
        }
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search tags")
        .navigationTitle("Tags")
        .background(Tokens.Canvas.background.color)
        .task { await browse.refresh() }
    }
}

/// The notes carrying one tag, and what can be done to the tag.
struct TaggedNotesView: View {
    @State private var model: TaggedNotesViewModel
    let browse: VaultBrowseViewModel
    /// Pushes a note, for the "+" that makes one carrying this tag.
    let open: (NoteRoute) -> Void

    @Environment(\.settingsContext) private var context
    @Environment(\.requestVaultSync) private var requestVaultSync
    @Environment(\.dismiss) private var dismiss

    /// Shared with the vault root and the folder screen, so every list of
    /// notes orders them the same way.
    @AppStorage("notes.browseSort") private var sort: BrowseSort = .modifiedNewest
    @AppStorage("notes.folderGrouping") private var grouping: FolderNoteGrouping = .none

    @State private var isRenaming = false
    @State private var draftName = ""
    @State private var isConfirmingDelete = false
    @State private var styling: TagItem?
    @State private var merging: TagItem?
    @State private var allTags: [TagItem] = []
    @State private var failure: UserFacingError?

    init(tag: String, browse: VaultBrowseViewModel, open: @escaping (NoteRoute) -> Void) {
        _model = State(initialValue: TaggedNotesViewModel(tag: tag, reader: browse.reader))
        self.browse = browse
        self.open = open
    }

    private var color: Color {
        let summary = browse.tags.first { $0.name.lowercased() == model.tag.lowercased() }
        return Tokens.Palette.color(summary?.color, tag: model.tag)
    }

    /// Everything the tag is on: notes, journals and tasks, which is what a
    /// rename or delete rewrites.
    private var itemCount: Int {
        allTags.first { $0.name.lowercased() == model.tag.lowercased() }
            .map { Int($0.notes + $0.journals + $0.tasks) } ?? 0
    }

    private var canCreate: Bool { browse.writer != nil && browse.metadataWriter != nil }

    var body: some View {
        content
            .navigationTitle("#\(model.tag)")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    FolderViewMenu(sort: $sort, grouping: $grouping)
                }
                if context != nil {
                    ToolbarItem(placement: .topBarTrailing) { tagMenu }
                }
            }
            .overlay(alignment: .bottomTrailing) {
                if canCreate {
                    FloatingAddButton(
                        label: "New note with #\(model.tag)",
                        hint: "Makes a note carrying this tag.",
                        identifier: "tag.addButton"
                    ) { Task { await createNote() } }
                    .padding(.horizontal, Tokens.Space.inset)
                    .padding(.bottom, Tokens.Space.medium)
                }
            }
            .background(Tokens.Canvas.background.color)
            .task {
                await model.loadIfNeeded()
                await loadAllTags()
            }
            .onAppear { Task { await model.refresh() } }
            .alert(TagsCopy.renameTitle(model.tag), isPresented: $isRenaming) {
                TextField(TagsCopy.newName, text: $draftName)
                    .textInputAutocapitalization(.never)
                Button(SettingsCopy.cancel, role: .cancel) {}
                Button(SettingsCopy.rename) { Task { await rename() } }
            } message: {
                Text(TagsCopy.renameMessage(itemCount))
            }
            .confirmationDialog(TagsCopy.deleteTitle(model.tag), isPresented: $isConfirmingDelete, titleVisibility: .visible) {
                Button(TagsCopy.deleteAction, role: .destructive) { Task { await delete() } }
            } message: {
                Text(TagsCopy.deleteMessage(itemCount))
            }
            .sheet(item: $styling) { tag in
                TagStyleSheet(tag: tag) { color, icon in Task { await style(tag, color: color, icon: icon) } }
            }
            .sheet(item: $merging) { source in
                TagMergeSheet(
                    source: source,
                    count: Int(source.notes + source.journals + source.tasks),
                    tags: allTags.filter { $0.name != source.name }
                ) { target in Task { await merge(into: target) } }
            }
            .alert(
                failure?.title ?? "",
                isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })
            ) {
                Button("OK", role: .cancel) { failure = nil }
            } message: {
                if let guidance = failure?.guidance { Text(guidance) }
            }
            .writeFailureAlert(browse)
    }

    @ViewBuilder
    private var content: some View {
        switch model.phase {
        case .loading:
            ProgressView { Text("Reading these notes") }
                .progressViewStyle(.circular)
                .font(Tokens.Typography.supporting.font)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case let .ready(notes):
            if notes.isEmpty {
                // Reachable: a tag tapped in a note whose tag row has since
                // been removed elsewhere, or one this device has not indexed.
                ContentUnavailableView {
                    Label("No notes with this tag", systemImage: "number")
                } description: {
                    Text("No note on this device carries #\(model.tag).")
                }
            } else {
                list(notes)
            }
        case let .failed(error):
            VStack(alignment: .leading, spacing: Tokens.Space.medium) {
                ErrorNotice(error: error, code: nil)
            }
            .padding(.horizontal, Tokens.Space.screenInline)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        }
    }

    /// Desktop's tag menu, plus Settings' merge.
    private var tagMenu: some View {
        Menu {
            Button(SettingsCopy.rename, systemImage: "pencil") {
                draftName = model.tag
                isRenaming = true
            }
            Button(TagsCopy.style, systemImage: "paintpalette") {
                Task {
                    await loadAllTags()
                    styling = currentItem
                }
            }
            Button(TagsCopy.merge, systemImage: "arrow.triangle.merge") {
                Task {
                    await loadAllTags()
                    merging = currentItem
                }
            }
            Button(TagsCopy.delete, systemImage: "trash", role: .destructive) { isConfirmingDelete = true }
        } label: {
            Label("Tag actions", systemImage: "number")
        }
    }

    private func list(_ notes: [NoteSummary]) -> some View {
        List {
            HStack(spacing: Tokens.Space.small) {
                Chip(text: model.tag, color: color, symbol: "#")
                Text(notes.count == 1 ? "1 note" : "\(notes.count) notes")
                    .font(Tokens.Typography.caption.font)
                    .foregroundStyle(Tokens.Text.secondary.color)
            }
            .padding(.horizontal, Tokens.Space.small)
            .accessibilityElement(children: .combine)
            .shortcutRow()
            switch grouping {
            case .none:
                ForEach(sort.sorted(notes), id: \.id) { note in
                    BrowseRowView(row: .note(note), toggle: { _ in }, model: browse)
                }
            case .date:
                ForEach(FolderNoteGroup.group(notes, sort: sort)) { group in
                    Section(group.bucket.title) {
                        ForEach(group.notes, id: \.id) { note in
                            BrowseRowView(row: .note(note), toggle: { _ in }, model: browse)
                        }
                    }
                }
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .environment(\.defaultMinListRowHeight, Tokens.Size.minimumHitArea)
    }

    // MARK: Writes

    private var currentItem: TagItem? {
        allTags.first { $0.name.lowercased() == model.tag.lowercased() }
    }

    private func loadAllTags() async {
        guard let context else { return }
        if case let .success(list) = await context.read({ try $0.tagList() }) { allTags = list }
    }

    /// A note carrying this tag, opened straight away.
    private func createNote() async {
        guard let metadataWriter = browse.metadataWriter,
              let id = await browse.createNote(in: nil) else { return }
        do {
            try await metadataWriter.setTags(id: id, tags: [model.tag])
        } catch {
            failure = ErrorMapping.userFacing(error)
        }
        requestVaultSync?()
        await afterWrite()
        open(NoteRoute(id: id))
    }

    private func rename() async {
        guard let context else { return }
        let old = model.tag
        let new = draftName.trimmingCharacters(in: .whitespaces)
        guard !new.isEmpty, new != old else { return }
        switch await context.run({ try $0.renameTag(oldName: old, newName: new) }) {
        case .success:
            model.tag = new
            await afterWrite()
        case let .failure(error):
            failure = error
        }
    }

    private func style(_ tag: TagItem, color: String?, icon: String?) async {
        guard let context else { return }
        styling = nil
        let name = tag.name
        if let color, color != tag.color,
           case let .failure(error) = await context.run({ try $0.setTagColor(tag: name, color: color) }) {
            failure = error
        }
        if icon != tag.icon,
           case let .failure(error) = await context.run({ try $0.setTagIcon(tag: name, icon: icon) }) {
            failure = error
        }
        await afterWrite()
    }

    private func merge(into target: String) async {
        guard let context else { return }
        merging = nil
        let source = model.tag
        switch await context.run({ try $0.mergeTag(source: source, target: target) }) {
        case .success:
            model.tag = target
            await afterWrite()
        case let .failure(error):
            failure = error
        }
    }

    /// Deleting the tag leaves its notes in place, so the page it named goes.
    private func delete() async {
        guard let context else { return }
        let name = model.tag
        switch await context.run({ try $0.deleteTag(tag: name) }) {
        case .success:
            await browse.refresh()
            dismiss()
        case let .failure(error):
            failure = error
        }
    }

    private func afterWrite() async {
        await model.refresh()
        await browse.refresh()
        await loadAllTags()
    }
}
