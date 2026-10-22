import MemryCore
import SwiftUI

// A `memry-portal` code block: a live, read-only window onto a note or one
// block of it (protocol chapter 12 §12.6.3).
//
// **The core resolves, the shell draws.** `Notes.portalSlice` turns the fence
// and the source note into blocks or a status; this view only titles the
// window, guards cycles and depth through the view tree, and pulls the source
// body so a window onto a note another device edits does not go stale. A portal
// that shows nothing says why in one quiet row (`PortalStateRow`).
//
// **Read-only, and never a writer.** Nothing here sets a block, and
// `NoteBlockView` keeps a portal out of the text editor, so the fence's bytes
// reach the vault exactly as they arrived, whatever state the portal is in.
// Editing through a portal needs its own `EditorSession` on the source note:
// a follow-up. A search portal draws its query and a hint; block-level search
// is desktop's for now.

struct PortalBlockView: View {
    let text: String

    @Environment(\.openNote) private var openNote
    @Environment(\.vaultBrowse) private var browse
    @Environment(\.vaultSyncPasses) private var syncPasses
    @Environment(\.portalAncestry) private var ancestry
    @Environment(\.portalHostNote) private var hostNote
    @State private var phase: Phase = .loading
    @State private var title: String?

    private enum Phase {
        case loading
        case ready(blocks: [Block], tables: [String: TableContent], attachments: [String: BlockAttachment])
        case state(PortalState)
    }

    var body: some View {
        let fence = PortalFence(text: text)
        if let reader = browse?.reader {
            PortalFrame(
                title: title,
                state: stateOf(phase),
                openSource: sourceRoute(fence).flatMap { route in openNote.map { open in { open(route) } } }
            ) { content(fence) }
            .task(id: "\(text)|\(syncPasses)|\(hostNote ?? "")") {
                await load(fence, reader: reader, filler: browse?.filler)
            }
        } else {
            CodeRow(language: PortalFence.language, text: text)
        }
    }

    private func sourceRoute(_ fence: PortalFence) -> NoteRoute? {
        switch fence.target {
        case let .note(id, _), let .blocks(id, _):
            if case .state(.missingNote) = phase { return nil }
            return NoteRoute(id: id)
        case .search, nil:
            return nil
        }
    }

    @ViewBuilder
    private func content(_ fence: PortalFence) -> some View {
        switch phase {
        case .loading:
            ProgressView()
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityLabel(PortalCopy.loading)
        case let .ready(blocks, tables, attachments):
            if let target = fence.target {
                NoteBlocksView(
                    blocks: blocks,
                    tableContent: { tables[$0] },
                    attachment: { attachments[$0] ?? .unknown }
                )
                .environment(\.portalAncestry, ancestry.withHost(hostNote).descending(into: target))
                .environment(\.portalHostNote, target.noteId)
                // The host's comments are pinned to the host's text.
                .environment(\.reviewMarks, [])
            }
        case .state:
            EmptyView()
        }
    }

    private func stateOf(_ phase: Phase) -> PortalState? {
        if case let .state(state) = phase { state } else { nil }
    }

    private func load(_ fence: PortalFence, reader: any NotesReading, filler: (any VaultFilling)?) async {
        guard let target = fence.target else {
            phase = .state(.invalid)
            return
        }
        if case let .search(text, tag) = target {
            phase = .state(.search(text: text, tag: tag))
            return
        }
        let sourceId = target.noteId
        if let refusal = ancestry.withHost(hostNote).refusal(for: target) {
            phase = .state(refusal == .cycle ? .cycle : .tooDeep)
            title = (try? await reader.read(id: sourceId))?.summary.title
            return
        }
        // A pass pulls no body edit that arrived as CRDT updates alone, so a
        // window onto another device's note pulls the source itself.
        if let filler {
            do {
                _ = try await filler.fetchNoteBody(noteId: sourceId)
            } catch {
                Log.sync.debug("a portal source body could not be pulled")
            }
        }
        do {
            title = try await reader.read(id: sourceId)?.summary.title
            let slice = try await reader.portalSlice(id: sourceId, definitionJson: text)
            switch slice.status {
            case .ok:
                phase = await .ready(
                    blocks: slice.blocks,
                    tables: tables(in: slice.blocks, of: sourceId, reader: reader),
                    attachments: attachments(in: slice.blocks, of: sourceId, reader: reader)
                )
            case .missingNote: phase = .state(.missingNote)
            case .missingBlock: phase = .state(.missingBlock)
            case .invalid: phase = .state(.invalid)
            }
        } catch {
            Log.storage.error("a portal could not be read")
            phase = .state(.failed)
        }
    }

    /// A table that will not read is left out, and draws its placeholder.
    private func tables(in blocks: [Block], of noteId: String, reader: any NotesReading) async -> [String: TableContent] {
        var loaded: [String: TableContent] = [:]
        for block in blocks where block.kind == "table" {
            guard let blockId = block.id else { continue }
            loaded[blockId] = try? await reader.table(id: noteId, blockId: blockId)
        }
        return loaded
    }

    private func attachments(in blocks: [Block], of noteId: String, reader: any NotesReading) async
        -> [String: BlockAttachment]
    {
        var bound: [String: BlockAttachment] = [:]
        for url in NoteReadViewModel.attachmentUrls(in: blocks) {
            bound[url] = try? await reader.attachmentForBlock(id: noteId, url: url)
        }
        return bound
    }
}

extension PortalTarget {
    var noteId: String {
        switch self {
        case let .note(id, _), let .blocks(id, _): id
        case .search: ""
        }
    }
}

extension EnvironmentValues {
    /// The windows between the note on screen and this portal.
    @Entry var portalAncestry = PortalAncestry()
    /// The note whose body holds the blocks being drawn, for the cycle guard.
    @Entry var portalHostNote: String?
}
