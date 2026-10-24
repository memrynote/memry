import MemryCore
import Observation
import SwiftUI

// Notes and journal days that spell this note's title or an alias as plain
// text without linking to it, with a Link action that turns one into
// `[[Title|name]]` (#3330, desktop's #3320). Matching lives in the core
// (`Search.unlinkedMentions`); this file holds the screen and the one edit.

@MainActor
@Observable
final class UnlinkedMentionsViewModel {
    enum Phase: Equatable {
        /// Not opened. The scan reads every candidate body, so nothing runs
        /// until the section is opened, as on desktop.
        case collapsed
        case loading
        case ready([UnlinkedMention])
        case failed(UserFacingError)
    }

    /// One mention of one source: the row a Link tap names.
    struct Key: Equatable {
        let sourceId: String
        let index: Int
    }

    private let noteId: String
    private let search: (any VaultSearching)?
    private let reader: any NotesReading
    private let editor: (any BlockEditing)?

    private(set) var phase: Phase = .collapsed
    private(set) var pending: Key?
    /// The last Link tap found its mention gone (edited elsewhere since the
    /// list was read). Not a failure: the list is re-read and shows the truth.
    private(set) var mentionChanged = false
    /// The last Link tap failed, shown under the list.
    private(set) var failure: UserFacingError?

    init(noteId: String, search: (any VaultSearching)?, reader: any NotesReading, editor: (any BlockEditing)?) {
        self.noteId = noteId
        self.search = search
        self.reader = reader
        self.editor = editor
    }

    var isAvailable: Bool { search != nil }
    var isOpen: Bool { phase != .collapsed }
    var canLink: Bool { editor != nil }

    func toggle() async {
        if isOpen {
            phase = .collapsed
            mentionChanged = false
            failure = nil
        } else {
            phase = .loading
            await load(reindexing: true)
        }
    }

    /// Replaces the `index`-th mention in `source` with a wiki link to this
    /// note. `true` when it landed, so the caller can ask for a sync pass.
    @discardableResult
    func link(_ source: UnlinkedMention, index: Int, targetTitle: String) async -> Bool {
        guard let editor, pending == nil, source.sourceKind == "note", source.mentions.indices.contains(index) else {
            return false
        }
        let key = Key(sourceId: source.sourceId, index: index)
        pending = key
        mentionChanged = false
        failure = nil
        defer { pending = nil }
        var landed = false
        do {
            landed = try await replace(source, index: index, targetTitle: targetTitle, editor: editor)
            mentionChanged = !landed
        } catch {
            Log.storage.error("an unlinked mention could not be linked")
            failure = ErrorMapping.userFacing(error)
        }
        await load(reindexing: true)
        return landed
    }

    private func replace(
        _ source: UnlinkedMention, index: Int, targetTitle: String, editor: any BlockEditing
    ) async throws -> Bool {
        let text = source.mentions[index]
        guard let blocks = try await reader.blocks(id: source.sourceId) else { return false }
        let spots = UnlinkedMentionLocator.spots(of: text, in: blocks)
        let expected = source.mentions.filter { $0 == text }.count
        let nth = source.mentions[..<index].filter { $0 == text }.count
        guard spots.count == expected, spots.indices.contains(nth) else { return false }
        let spot = spots[nth]
        return try await editor.edit(
            noteId: source.sourceId,
            .insertInline(
                blockId: spot.blockId,
                start: UInt32(spot.start),
                end: UInt32(spot.end),
                kind: "wikiLink",
                text: "",
                attrs: WikiLinkAttrs.attrs(target: targetTitle, alias: text)
            )
        )
    }

    private func load(reindexing: Bool) async {
        guard let search else { return }
        do {
            if reindexing { try await search.reindex() }
            let rows = try await search.unlinkedMentions(targetId: noteId)
            if isOpen { phase = .ready(rows) }
        } catch {
            Log.storage.error("the unlinked mentions could not be read")
            if isOpen { phase = .failed(ErrorMapping.userFacing(error)) }
        }
    }
}

struct UnlinkedMentionsSection: View {
    let model: UnlinkedMentionsViewModel
    /// The note's title, which is what a link targets.
    let targetTitle: String
    let open: (NoteRoute) -> Void

    @Environment(\.requestVaultSync) private var requestVaultSync
    @Environment(\.openJournalDay) private var openJournalDay

    var body: some View {
        if model.isAvailable {
            VStack(alignment: .leading, spacing: Tokens.Space.small) {
                header
                if model.isOpen { content }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var header: some View {
        Button { Task { await model.toggle() } } label: {
            HStack(spacing: Tokens.Space.small) {
                Image(systemName: "chevron.right")
                    .rotationEffect(.degrees(model.isOpen ? 90 : 0))
                    .accessibilityHidden(true)
                Text(title)
                Spacer()
            }
            .font(Tokens.Typography.heading.font)
            .foregroundStyle(Tokens.Text.primary.color)
            .frame(minHeight: Tokens.Size.minimumHitArea)
            .contentShape(.rect)
        }
        .accessibilityLabel(title)
        .accessibilityValue(model.isOpen ? "Expanded" : "Collapsed")
        .accessibilityIdentifier("note.unlinkedMentions")
    }

    private var title: String {
        if case let .ready(rows) = model.phase {
            return rows.isEmpty ? "No unlinked mentions" : "Unlinked mentions (\(rows.count))"
        }
        return "Unlinked mentions"
    }

    @ViewBuilder
    private var content: some View {
        switch model.phase {
        case .collapsed:
            EmptyView()
        case .loading:
            ProgressView()
        case let .ready(rows):
            ForEach(rows, id: \.sourceId) { source in
                sourceRows(source)
            }
            if model.mentionChanged {
                Text("That mention changed. The list is up to date now.")
                    .font(Tokens.Typography.caption.font)
                    .foregroundStyle(Tokens.Text.secondary.color)
            }
            if let failure = model.failure { ErrorNotice(error: failure, code: nil) }
        case let .failed(error):
            ErrorNotice(error: error, code: nil)
        }
    }

    private func sourceRows(_ source: UnlinkedMention) -> some View {
        VStack(alignment: .leading, spacing: Tokens.Space.tight) {
            Button { openSource(source) } label: {
                Text(source.sourceTitle.isEmpty ? "Untitled note" : source.sourceTitle)
                    .font(Tokens.Typography.body.font)
                    .foregroundStyle(Tokens.Text.primary.color)
                    .frame(maxWidth: .infinity, minHeight: Tokens.Size.minimumHitArea, alignment: .leading)
                    .contentShape(.rect)
            }
            .disabled(source.sourceKind == "journal" && openJournalDay == nil)
            ForEach(Array(source.mentions.enumerated()), id: \.offset) { index, text in
                HStack {
                    Text("“\(text)”")
                        .font(Tokens.Typography.caption.font)
                        .foregroundStyle(Tokens.Text.secondary.color)
                    Spacer()
                    if source.sourceKind == "note", model.canLink {
                        Button("Link") { link(source, index) }
                            .disabled(model.pending != nil)
                            .frame(minHeight: Tokens.Size.minimumHitArea)
                            .accessibilityLabel("Link “\(text)”")
                            .accessibilityIdentifier("note.unlinkedMention.link.\(source.sourceId).\(index)")
                    }
                }
                .padding(.leading, Tokens.Space.medium)
            }
        }
        .accessibilityElement(children: .contain)
    }

    private func openSource(_ source: UnlinkedMention) {
        if source.sourceKind == "journal" {
            if let date = source.sourceDate { openJournalDay?(date) }
        } else {
            open(NoteRoute(id: source.sourceId))
        }
    }

    private func link(_ source: UnlinkedMention, _ index: Int) {
        Task {
            if await model.link(source, index: index, targetTitle: targetTitle) { requestVaultSync?() }
        }
    }
}
