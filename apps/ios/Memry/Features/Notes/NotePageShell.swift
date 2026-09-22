//
//  NotePageShell.swift
//  Find in note, the attachments list, and the page overflow menu.
//
//  N801, N805, N808.
//

import MemryCore
import Observation
import SwiftUI
import UIKit

// MARK: - N801, find in note

/// One match: which block it is in, and where.
struct NoteMatch: Equatable, Identifiable, Sendable {
    let id: Int
    /// The index of the block in the flat list, so a caller can scroll to it.
    let blockIndex: Int
    let blockId: String?
    /// The whole line the match sits in, for the result row.
    let line: String
}

/// Searching inside one note's blocks.
///
/// **Client-side over blocks already read, not a query.** The note is on
/// screen, so its text is already here; going back to the core would be a
/// second read of something this view is holding, and it would search the
/// flattened note rather than the blocks the user can be scrolled to.
enum NoteFind {
    /// Every block whose text contains `query`, case-insensitively.
    ///
    /// Case-insensitive because a reader looking for "kitchen" means the
    /// sentence that starts one. Empty for an empty query rather than every
    /// block, which is what "no search" should look like.
    static func matches(of query: String, in blocks: [Block]) -> [NoteMatch] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !needle.isEmpty else { return [] }

        return blocks.enumerated().compactMap { index, block in
            let line = block.inline.map(\.text).joined()
            guard line.localizedCaseInsensitiveContains(needle) else { return nil }
            return NoteMatch(
                id: index,
                blockIndex: index,
                blockId: block.id,
                line: line
            )
        }
    }
}

/// The find bar and its results.
struct NoteFindView: View {
    let blocks: [Block]
    /// Scrolls the note to a block. `nil` lists matches without moving.
    var scrollTo: ((String) -> Void)?

    @State private var query = ""

    private var matches: [NoteMatch] { NoteFind.matches(of: query, in: blocks) }

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.small) {
            TextField("Find in note", text: $query)
                .textFieldStyle(.roundedBorder)
                .font(Tokens.Typography.body.font)
                .accessibilityLabel("Find in this note")

            if !query.trimmingCharacters(in: .whitespaces).isEmpty {
                if matches.isEmpty {
                    // The truth, rather than an empty list that reads as a
                    // still-loading one.
                    Text("Nothing in this note matches.")
                        .font(Tokens.Typography.supporting.font)
                        .foregroundStyle(Tokens.Text.secondary.color)
                } else {
                    Text("\(matches.count) \(matches.count == 1 ? "match" : "matches")")
                        .font(Tokens.Typography.caption.font)
                        .foregroundStyle(Tokens.Text.secondary.color)

                    ForEach(matches) { match in
                        Button {
                            if let id = match.blockId { scrollTo?(id) }
                        } label: {
                            Text(match.line)
                                .font(Tokens.Typography.supporting.font)
                                .foregroundStyle(Tokens.Text.primary.color)
                                .lineLimit(2)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .disabled(match.blockId == nil || scrollTo == nil)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - N805, the attachments on a note

/// Everything this vault knows one note references.
///
/// **An empty list is not "this note has no attachments."** It is also what a
/// note whose references have never arrived looks like, because an absent
/// `attachmentReferences` means "this sender does not know" (§14.7). The
/// screen says which of the two it is showing rather than rendering both the
/// same way.
struct NoteAttachmentsList: View {
    let attachments: [CachedAttachment]
    var remove: ((String) async -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.small) {
            if attachments.isEmpty {
                Text("This device does not know of any attachment on this note.")
                    .font(Tokens.Typography.supporting.font)
                    .foregroundStyle(Tokens.Text.secondary.color)
            } else {
                ForEach(attachments, id: \.attachmentId) { attachment in
                    HStack(spacing: Tokens.Space.small) {
                        Image(systemName: symbol(for: attachment.mimeType))
                            .foregroundStyle(Tokens.Text.secondary.color)
                        VStack(alignment: .leading, spacing: Tokens.Space.tight) {
                            Text(attachment.filename ?? "Untitled attachment")
                                .font(Tokens.Typography.body.font)
                                .foregroundStyle(Tokens.Text.primary.color)
                            Text(subtitle(for: attachment))
                                .font(Tokens.Typography.caption.font)
                                .foregroundStyle(Tokens.Text.secondary.color)
                        }
                        Spacer()
                        if let remove {
                            Button(role: .destructive) {
                                Task { await remove(attachment.attachmentId) }
                            } label: {
                                Image(systemName: "trash")
                            }
                            .accessibilityLabel(
                                "Remove \(attachment.filename ?? "this attachment")"
                            )
                        }
                    }
                    .accessibilityElement(children: .combine)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Downloaded or not, said plainly. A row with no bytes is waiting rather
    /// than broken (FR-045).
    private func subtitle(for attachment: CachedAttachment) -> String {
        guard attachment.localPath != nil else { return "Not downloaded yet" }
        // A size this device has not been told is **unknown**, not zero: the
        // manifest may not have arrived, and "0 bytes" would be a claim.
        guard let size = attachment.remoteSize else { return "Downloaded" }
        return ByteCountFormatter.string(fromByteCount: size, countStyle: .file)
    }

    private func symbol(for mimeType: String?) -> String {
        guard let mimeType else { return "doc" }
        if mimeType.hasPrefix("image/") { return "photo" }
        if mimeType.hasPrefix("audio/") { return "waveform" }
        if mimeType.hasPrefix("video/") { return "film" }
        return "doc"
    }
}

// MARK: - N808, the page overflow menu

/// The note page's overflow menu.
///
/// **Two of the six the task names are not this client's to offer.**
/// `bookmark` is one of the twelve record types §5.3.1 says a conforming
/// client omits from its subscription header and never sees, so a bookmark
/// action here would be acting on a record this client is specified not to
/// hold. And "local-only" is a desktop cache flag rather than a synced field
/// — there is nothing in the note payload to write. Both are left out rather
/// than faked; `research.md` records why.
struct NotePageMenu: View {
    let canWrite: Bool
    let folderPath: String?
    let rename: () -> Void
    let move: () -> Void
    let delete: () -> Void

    var body: some View {
        Menu {
            if canWrite {
                Button {
                    rename()
                } label: {
                    Label("Rename", systemImage: "pencil")
                }
                Button {
                    move()
                } label: {
                    Label("Move to folder", systemImage: "folder")
                }
            }
            Button {
                // The vault-relative path, which is what a user would paste
                // somewhere else. The root is a note with no folder.
                UIPasteboard.general.string = folderPath ?? ""
            } label: {
                Label("Copy path", systemImage: "doc.on.doc")
            }
            .disabled(folderPath == nil)

            if canWrite {
                Divider()
                Button(role: .destructive) {
                    delete()
                } label: {
                    Label("Delete", systemImage: "trash")
                }
            }
        } label: {
            Label("More", systemImage: "ellipsis.circle")
                .labelStyle(.iconOnly)
        }
        .accessibilityLabel("More actions for this note")
    }
}

/// The page menu's three write actions (N808).
///
/// Its own model rather than more state on the read view, which is already
/// the longest file in the feature: rename, move and delete each need a
/// failure path, and three more `@State` flags plus three `Task` blocks would
/// have gone somewhere that is about reading a note.
@MainActor
@Observable
final class NotePageActions {
    enum Status: Equatable {
        case idle
        case working
        case failed(UserFacingError)
    }

    private let noteId: String
    private let writer: (any NotesWriting)?

    private(set) var status: Status = .idle
    /// `true` once the note is gone, so the caller can leave the screen
    /// rather than showing a note that no longer exists.
    private(set) var deleted = false

    init(noteId: String, writer: (any NotesWriting)?) {
        self.noteId = noteId
        self.writer = writer
    }

    var canWrite: Bool { writer != nil }

    func rename(to title: String) async {
        guard let writer else { return }
        await run { try await writer.rename(id: noteId, title: title) }
    }

    /// `nil` is the vault root, and it travels as an explicit null so every
    /// other device does not keep the old folder (§13.4).
    func move(to folderPath: String?) async {
        guard let writer else { return }
        await run { try await writer.move(id: noteId, folderPath: folderPath) }
    }

    func delete() async {
        guard let writer else { return }
        await run { try await writer.delete(id: noteId) }
        if status == .idle { deleted = true }
    }

    func dismissFailure() { status = .idle }

    private func run(_ work: () async throws -> Void) async {
        status = .working
        do {
            try await work()
            status = .idle
        } catch {
            Log.storage.error("a note page action did not land")
            status = .failed(ErrorMapping.userFacing(error))
        }
    }
}

/// Where a note can be moved to (N808).
///
/// The vault root is offered as its own row rather than as an empty entry,
/// because "no folder" is a real destination and §13.4's explicit null is how
/// it travels.
struct NoteFolderPicker: View {
    let current: String?
    let choose: (String?) -> Void

    /// Every folder in the vault. Handed in rather than read here, so this
    /// view does no I/O of its own.
    var folders: [FolderSummary] = []

    var body: some View {
        NavigationStack {
            List {
                Button {
                    choose(nil)
                } label: {
                    Label("Vault root", systemImage: "tray")
                }
                .disabled(current == nil)

                ForEach(folders, id: \.path) { folder in
                    Button {
                        choose(folder.path)
                    } label: {
                        Label(folder.path, systemImage: "folder")
                    }
                    .disabled(folder.path == current)
                }
            }
            .navigationTitle("Move to folder")
        }
    }
}

// MARK: - N800, the backlinks section

/// The notes linking to this one.
///
/// **Answerable only since the link projection landed.** `note_links` existed
/// in the index schema and nothing wrote a row into it, so this section would
/// have read "no note links here" forever — which is why it is a section with
/// a real empty state rather than one that hides when empty.
@MainActor
@Observable
final class BacklinksViewModel {
    enum Phase: Equatable {
        case loading
        case ready([Backlink])
        case failed(UserFacingError)
    }

    private let noteId: String
    private let search: (any VaultSearching)?

    private(set) var phase: Phase = .loading
    var order: BacklinkOrder = .recent {
        didSet {
            guard order != oldValue else { return }
            Task { await load() }
        }
    }

    init(noteId: String, search: (any VaultSearching)?) {
        self.noteId = noteId
        self.search = search
    }

    func loadIfNeeded() async {
        guard case .loading = phase else { return }
        await load()
    }

    private func load() async {
        guard let search else {
            phase = .ready([])
            return
        }
        do {
            phase = .ready(try await search.backlinks(noteId: noteId, order: order))
        } catch {
            Log.storage.error("the backlinks could not be read")
            phase = .failed(ErrorMapping.userFacing(error))
        }
    }
}

struct BacklinksSection: View {
    let model: BacklinksViewModel
    let open: (NoteRoute) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.small) {
            HStack {
                Text("Linked from")
                    .font(Tokens.Typography.heading.font)
                    .foregroundStyle(Tokens.Text.primary.color)
                Spacer()
                Picker("Order", selection: Binding(
                    get: { model.order },
                    set: { model.order = $0 }
                )) {
                    Text("Recent").tag(BacklinkOrder.recent)
                    Text("Title").tag(BacklinkOrder.title)
                    Text("Oldest").tag(BacklinkOrder.oldest)
                }
                .pickerStyle(.menu)
                .accessibilityLabel("Order backlinks")
            }

            switch model.phase {
            case .loading:
                ProgressView()
                    .progressViewStyle(.circular)
            case let .ready(backlinks):
                if backlinks.isEmpty {
                    Text("No note links here yet.")
                        .font(Tokens.Typography.supporting.font)
                        .foregroundStyle(Tokens.Text.secondary.color)
                } else {
                    ForEach(backlinks, id: \.sourceId) { backlink in
                        Button {
                            open(NoteRoute(id: backlink.sourceId))
                        } label: {
                            VStack(alignment: .leading, spacing: Tokens.Space.tight) {
                                Text(
                                    backlink.viaProperty
                                        // Desktop's own label for a link that
                                        // is not a sentence the user wrote.
                                        ? "\(backlink.targetTitle) → \(backlink.sourceTitle)"
                                        : backlink.sourceTitle
                                )
                                .font(Tokens.Typography.body.font)
                                .foregroundStyle(Tokens.Text.primary.color)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                }
            case let .failed(error):
                ErrorNotice(error: error, code: nil)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .task { await model.loadIfNeeded() }
    }
}
