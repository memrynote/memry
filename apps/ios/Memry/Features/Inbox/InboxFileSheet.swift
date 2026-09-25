import MemryCore
import SwiftUI

// IB13. The File sheet (Paper 13, desktop `filing-section.tsx`): search or
// create a folder (`/` nests), Recent folders (no suggestions on iOS, D5 and
// §6 IB001/F8), All folders, tags with suggestions, link to existing or new
// notes (one capture only, desktop's bulk rule), and for an image the filing
// mode with Don't ask again. Confirm is disabled until the choice is valid.

struct InboxFileSheet: View {
    let store: InboxStore
    let ids: [String]
    var done: () -> Void = {}

    @Environment(\.dismiss) private var dismiss
    @State private var search = ""
    @State private var folder: String?
    @State private var folders: [String] = []
    @State private var tags: [String] = []
    @State private var tagSuggestions: [String] = []
    @State private var newTag = ""
    @State private var addingTag = false
    @State private var links: [InboxLinkChoice] = []
    @State private var noteQuery = ""
    @State private var noteResults: [NoteSummary] = []
    @AppStorage(InboxPreferences.imageModeKey) private var imageModeRaw = InboxImageMode.embed.rawValue
    @AppStorage(InboxPreferences.imageModeRememberedKey) private var remembered = false

    private var items: [InboxItemRecord] { ids.compactMap(store.item) }
    private var single: InboxItemRecord? { ids.count == 1 ? items.first : nil }
    private var isImage: Bool { single?.itemType == "image" }
    private var imageMode: InboxImageMode { InboxImageMode(rawValue: imageModeRaw) ?? .embed }

    /// Embedding an image needs a note to embed it in (desktop's guard).
    private var canConfirm: Bool {
        if !links.isEmpty { return true }
        if isImage, imageMode == .embed, !remembered { return folder != nil }
        return folder != nil
    }

    var body: some View {
        NavigationStack {
            List {
                searchSection
                foldersSection
                tagsSection
                if single != nil { linksSection } else { Section { Text(InboxCopy.bulkNoLinks).font(Tokens.Typography.caption.font) } }
                if isImage, !remembered { imageSection }
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(Tokens.Canvas.background.color)
            .navigationTitle(InboxCopy.file)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(InboxCopy.close, systemImage: "xmark") { dismiss() }
                        .accessibilityIdentifier("inbox.file.close")
                }
                ToolbarItem(placement: .confirmationAction) {
                    SheetConfirmButton(label: InboxCopy.fileItems(ids.count), isEnabled: canConfirm) { confirm() }
                        .accessibilityIdentifier("inbox.file.confirm")
                }
            }
            .task { await load() }
            .task(id: noteQuery) { await searchNotes() }
            .alert(InboxCopy.addTag, isPresented: $addingTag) {
                TextField(InboxCopy.addTagsPlaceholder, text: $newTag)
                Button(InboxCopy.cancel, role: .cancel) { newTag = "" }
                Button(InboxCopy.addTag) { addTag(newTag) }
            }
        }
        .presentationDetents([.medium, .large])
        .accessibilityIdentifier("inbox.fileSheet")
    }

    // MARK: Sections

    private var searchSection: some View {
        Section {
            TextField(InboxCopy.searchOrCreate, text: $search)
                .textInputAutocapitalization(.never)
                .accessibilityIdentifier("inbox.file.search")
            let query = search.trimmingCharacters(in: .whitespaces)
            if !query.isEmpty {
                ForEach(folders.filter { $0.localizedCaseInsensitiveContains(query) }.prefix(8), id: \.self) { path in
                    folderRow(path, detail: nil)
                }
                if !folders.contains(where: { $0.caseInsensitiveCompare(query) == .orderedSame }) {
                    Button {
                        folder = query.split(separator: "/").map { $0.trimmingCharacters(in: .whitespaces) }
                            .filter { !$0.isEmpty }.joined(separator: "/")
                        search = ""
                    } label: {
                        Label(InboxCopy.createFolder(query), systemImage: "folder.badge.plus")
                    }
                    .accessibilityIdentifier("inbox.file.createFolder")
                }
            }
        }
    }

    private var foldersSection: some View {
        Section(InboxCopy.recentFolders) {
            if let folder, !store.recentFolders.contains(folder) { folderRow(folder, detail: nil) }
            ForEach(store.recentFolders, id: \.self) { path in folderRow(path, detail: nil) }
            folderRow("", detail: nil)
            NavigationLink(InboxCopy.allFolders) {
                List(folders, id: \.self) { path in folderRow(path, detail: nil) }
                    .navigationTitle(InboxCopy.allFolders)
            }
            .accessibilityIdentifier("inbox.file.allFolders")
        }
    }

    private func folderRow(_ path: String, detail: String?) -> some View {
        Button {
            folder = path
        } label: {
            HStack {
                Label(InboxFolderName.display(path), systemImage: "folder")
                    .foregroundStyle(Tokens.Text.primary.color)
                Spacer()
                if folder == path {
                    Image(systemName: "checkmark")
                        .foregroundStyle(Tokens.Text.tint.color)
                        .accessibilityHidden(true)
                }
            }
            .frame(minHeight: Tokens.Size.minimumHitArea)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(folder == path ? .isSelected : [])
        .accessibilityIdentifier("inbox.file.folder.\(path.isEmpty ? "root" : path)")
    }

    private var tagsSection: some View {
        Section(InboxCopy.tags) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: Tokens.Space.small) {
                    ForEach(tags, id: \.self) { tag in
                        Button {
                            tags.removeAll { $0 == tag }
                        } label: {
                            Label("#\(tag)", systemImage: "xmark")
                                .labelStyle(InboxTrailingIconLabel())
                        }
                        .buttonStyle(InboxChipStyle(selected: true))
                        .accessibilityLabel(InboxCopy.removeTag(tag))
                    }
                    ForEach(tagSuggestions.filter { !tags.contains($0) }.prefix(3), id: \.self) { tag in
                        Button("+ #\(tag)") { addTag(tag) }
                            .buttonStyle(InboxChipStyle(selected: false))
                    }
                }
            }
            Button(InboxCopy.addTag) { addingTag = true }
                .foregroundStyle(Tokens.Text.tint.color)
                .accessibilityIdentifier("inbox.file.addTag")
        }
    }

    private var linksSection: some View {
        Section(InboxCopy.linkToNotes) {
            ForEach(links, id: \.self) { link in
                HStack {
                    Label(link.title, systemImage: link.noteId == nil ? "doc.badge.plus" : "doc")
                    Spacer()
                    Button(InboxCopy.close, systemImage: "xmark") { links.removeAll { $0 == link } }
                        .labelStyle(.iconOnly)
                        .accessibilityLabel(InboxCopy.removeLink(link.title))
                }
            }
            TextField(InboxCopy.findOrCreateNote, text: $noteQuery)
                .accessibilityIdentifier("inbox.file.noteSearch")
            let query = noteQuery.trimmingCharacters(in: .whitespaces)
            if !query.isEmpty {
                ForEach(noteResults.prefix(6), id: \.id) { note in
                    Button(note.title) {
                        links.append(InboxLinkChoice(noteId: note.id, title: note.title))
                        noteQuery = ""
                    }
                }
                Button(InboxCopy.createNote(query)) {
                    links.append(InboxLinkChoice(noteId: nil, title: query))
                    noteQuery = ""
                }
                .accessibilityIdentifier("inbox.file.createNote")
            }
        }
    }

    private var imageSection: some View {
        Section {
            Picker(InboxCopy.imageLandsAs, selection: $imageModeRaw) {
                Text(InboxCopy.imageEmbed).tag(InboxImageMode.embed.rawValue)
                Text(InboxCopy.imageLink).tag(InboxImageMode.link.rawValue)
            }
            Toggle(InboxCopy.dontAskAgain, isOn: $remembered)
        } footer: {
            if imageMode == .embed, links.isEmpty { Text(InboxCopy.embedNeedsNote) }
        }
    }

    // MARK: Work

    private func load() async {
        folder = folder ?? store.recentFolders.first ?? ""
        tags = single?.tags ?? []
        guard let notes = store.notes else { return }
        let loaded = try? await store.executorRun { (try notes.folders(), try notes.tags()) }
        folders = loaded?.0.map(\.path).sorted() ?? []
        tagSuggestions = loaded?.1.sorted { $0.noteCount > $1.noteCount }.map(\.name) ?? []
    }

    private func searchNotes() async {
        let query = noteQuery.trimmingCharacters(in: .whitespaces)
        guard !query.isEmpty, let notes = store.notes else {
            noteResults = []
            return
        }
        try? await Task.sleep(for: .milliseconds(200))
        let all = (try? await store.executorRun { try notes.list() }) ?? []
        noteResults = all.filter { $0.title.localizedCaseInsensitiveContains(query) && !links.map(\.noteId).contains($0.id) }
    }

    private func addTag(_ raw: String) {
        let tag = raw.trimmingCharacters(in: .whitespaces).trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        newTag = ""
        guard !tag.isEmpty, !tags.contains(where: { $0.caseInsensitiveCompare(tag) == .orderedSame }) else { return }
        tags.append(tag)
    }

    private func confirm() {
        let chosenFolder = folder ?? ""
        let chosenLinks = links
        let chosenTags = tags
        let mode = imageMode
        dismiss()
        Task {
            if let item = single {
                if chosenLinks.isEmpty {
                    await store.file(item, to: chosenFolder, tags: chosenTags)
                } else {
                    await store.link(item, to: chosenLinks, folder: chosenFolder, tags: chosenTags, imageMode: mode)
                }
            } else {
                await store.file(ids, to: chosenFolder, tags: chosenTags)
            }
            done()
        }
    }
}

/// Device-local inbox preferences (desktop keeps them local too, §5 F11).
enum InboxPreferences {
    static let imageModeKey = "inbox.imageFilingMode"
    static let imageModeRememberedKey = "inbox.imageFilingModeRemembered"
}

/// A tag chip: selected = filled, suggestion = outlined.
struct InboxChipStyle: ButtonStyle {
    let selected: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Tokens.Typography.supporting.font)
            .foregroundStyle(Tokens.Text.primary.color)
            .padding(.horizontal, Tokens.Space.medium)
            .frame(minHeight: Tokens.Size.pill)
            .background(selected ? Tokens.Canvas.surfaceActive.color : .clear, in: .capsule)
            .overlay { if !selected { Capsule().strokeBorder(Tokens.Line.border.color, lineWidth: Tokens.Size.hairline) } }
            .frame(minHeight: Tokens.Size.minimumHitArea)
            .opacity(configuration.isPressed ? 0.6 : 1)
    }
}

struct InboxTrailingIconLabel: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: Tokens.Space.tight) {
            configuration.title
            configuration.icon.font(Tokens.Typography.caption.font).foregroundStyle(Tokens.Text.tertiary.color)
        }
    }
}
