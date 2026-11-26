import Foundation
import MemryCore
import Observation

// T157, the state half. One note, read-only.
//
// **This is a preview, not a render.** It began as T157's placeholder
// (spec-defect 125, Kaan's decision); the render is now the core's block list,
// drawn by `NoteBlocksView`, and this preview remains for a note whose blocks
// are not on this phone. `NoteBody.text` is `extract_text` output (chapter 12
// §12.1.3), so a heading arrives as `# `, a bullet as `- `, and bold, links and
// code fences arrive as nothing at all. Nothing here parses or serialises a
// body's markdown: §12.1.2 forbids a non-desktop client from doing either
// outside two core writes (§12.1.0).
//
// The four outcomes of a read, and why no two share a screen, are in
// `NoteReadParts.swift` beside the types that carry them.
//
// **The call blocks.** `Notes.read(id:)` is a local SQLite read plus a `yrs`
// apply (`contracts/core-api.md`, the read slice), so it goes on the shell's
// serial `CoreExecutor` and is never awaited directly — and it offers no
// Cancel, because a blocking call has nothing to cancel (spec-defect 108).
//
// **No title, id, folder path or body text reaches a log** (Constitution II).
// `Log` takes a `StaticString` and a closed `LogDetail`; a count and an error
// code are the only things that can be said about a note here.

@MainActor
@Observable
final class NoteReadViewModel {

    /// Posted with a note id once that note's title is saved. Each page on
    /// the note re-reads it (`NotePageLoad`).
    nonisolated static let titleSaved = Notification.Name("memry.note.titleSaved")

    let route: NoteRoute

    /// The reader in use. Internal so the wiring suite can assert the
    /// production graph holds the **core** reader rather than something that
    /// behaves like it — Phase 3 shipped five tiers that were fully tested
    /// behind fakes and never called once.
    let reader: any NotesReading

    /// T237. The on-demand body pull, or `nil` when this screen has no session
    /// to fetch through.
    ///
    /// **This is what keeps `.notPulled` from being a dead end.** The first
    /// sync's bodies pass is windowed to the recent thirty days (chapter 10
    /// §10.6.1, FR-028 "older content on demand"), so on a real account most
    /// notes arrive with their metadata and `NoteBody.present == false`.
    /// Without this, such a note could never become readable — spec-defect 136
    /// again, at note granularity.
    let filler: (any VaultFilling)?

    /// The current network path, for FR-045's metered policy, which is the
    /// core's (`may_download`). Optional so a test can leave it out.
    let reachability: (any Reachability)?

    /// Resolves an attachment's relative `localPath`; any vault open moves the default's directory (#5847).
    let attachmentURL: @Sendable (String) -> URL

    private(set) var phase: Phase = .loading
    private(set) var fetch: Fetch = .idle
    /// A binary note's own file (#5668), or `nil` for a note with a body.
    /// Read and fetched in `NoteFileRead.swift`.
    var file: NoteFile?
    var fileFetch: Fetch = .idle
    /// The rendered body. Empty means "nothing to draw", which the screen
    /// resolves against `preview`: a body that is present and empty, a body
    /// that was never pulled, and a reader that cannot walk blocks are three
    /// different facts and only the first two are the note's.
    private(set) var blocks: [Block] = []
    /// The page editor's `EditorSession.landedWrites`, set by the page.
    @ObservationIgnored var landedWrites: () -> Int = { 0 }
    /// The writes `blocks` includes: `landedWrites` as it was read (#4738).
    @ObservationIgnored private(set) var blocksGeneration = 0
    /// The first walk of the blocks has finished, whatever it found.
    private(set) var blocksRead = false
    /// A walk of the body on screen has answered, present or not (#5507).
    private(set) var blocksWalked = false
    /// Each table in the body, by the block id of its `table` block.
    ///
    /// Read eagerly once the blocks land, rather than lazily while drawing:
    /// the reader is async and a SwiftUI body is not, and a table that
    /// appeared a frame late would reflow the note under the reader's eyes.
    /// A note holds few tables, so the cost is a few local reads.
    private(set) var tables: [String: TableContent] = [:]
    /// What each attachment-bearing block's `url` binds to.
    ///
    /// Keyed by the url the block carries, because that is what the block has
    /// — an attachment id is what the binding *produces*. Re-read after a
    /// download so a picture becomes visible **without the note being
    /// recreated**, which is what FR-045 asks for in as many words.
    private(set) var attachments: [String: BlockAttachment] = [:]
    /// On-open downloads running or failed, by id; `fetchWaitingAttachments` writes it (#5644).
    var attachmentFetches: [String: AttachmentFetchState] = [:]
    /// The note's tags and typed properties, or `nil` while they are unread.
    ///
    /// `nil` and "read, and it has none" are different: the first draws
    /// nothing because the answer has not arrived, the second draws nothing
    /// because there is nothing — and only the first may change on its own.
    private(set) var metadata: NoteMetadata?
    /// The note's review comments and suggestions (N604), read only, as the
    /// core read them. Private, so every screen shows `shownComments`.
    private var comments: [ReviewComment] = []
    /// The review marks as this note shows them, each `visibleText` resolved
    /// against its text (`ReviewMarkStyle.resolved`): what the Review list
    /// lists and the body draws. A note with no marks reads no text, so a
    /// view showing them does not redraw on every body change.
    var shownComments: [ReviewComment] {
        guard !comments.isEmpty else { return [] }
        return ReviewMarkStyle.resolved(comments, in: exportText)
    }
    /// Each task block's task, by task id, for the row desktop draws.
    private(set) var taskCards: [String: TaskCard] = [:]
    private var hasLoaded = false
    /// The open's read and walk, which a sync pass's refresh joins rather than
    /// restarts, which held a large note on `.loading` (#5247). Leaving cancels it.
    @ObservationIgnored private var opening: Task<Void, Never>?
    /// `opening` has not had the page's own refresh, whose pull follows the
    /// open's read. A later refresh may follow a pass that applied after it.
    @ObservationIgnored private var openAwaitsRefresh = false

    init(
        route: NoteRoute, reader: any NotesReading,
        filler: (any VaultFilling)? = nil, reachability: (any Reachability)? = nil,
        attachmentURL: @escaping @Sendable (String) -> URL = AttachmentPaths.url(for:)
    ) {
        self.route = route
        self.reader = reader
        self.filler = filler
        self.reachability = reachability
        self.attachmentURL = attachmentURL
    }

    /// Fetches this note's body, then re-reads it.
    ///
    /// Two steps and not one, because they are two facts: the fetch writes the
    /// document's updates into the local database, and `Notes.read` is what
    /// turns them into text. A screen that showed the body without re-reading
    /// would be rendering the summary it was handed rather than what landed.
    ///
    /// `SyncError.UnknownNote` arrives here for a note this vault has no live
    /// record of. It is **permanent** — the mapped copy says so and carries
    /// `.blocked`, so the view offers no retry over it.
    func fetchBody() async {
        guard filler != nil, fetch != .fetching else { return }
        fetch = .fetching
        // Not cancelled with the screen's task. The pull cannot be (spec-
        // defect 108), so a page task cancelled mid-pull would leave the body
        // it landed unread, and during a first sync no pass comes to re-read
        // it (`VaultFillView`).
        await Task { await pullBody() }.value
    }

    private func pullBody() async {
        guard let filler else { return }
        do {
            let summary = try await filler.fetchNoteBody(noteId: route.id)
            Log.sync.notice("fetched one note body", .count(Int(summary.updates)))
            fetch = summary.stopped ? .incomplete : .idle
        } catch {
            let mapped = ErrorMapping.userFacing(error)
            Log.sync.error("a note body could not be fetched", .code(mapped.code))
            fetch = .failed(mapped)
            return
        }
        hasLoaded = false
        // The body waits for its walk (#5247); a page on screen stays, or a new note's title loses its caret (#4893).
        if case .ready = phase { blocksWalked = false; await load(quietly: true) } else { await load() }
    }

    /// Pulls this note's body, then re-reads the note in place. Answers
    /// whether it read the note again, which can bind pictures to fetch.
    ///
    /// Runs on appear and after every sync pass: a desktop body edit is CRDT
    /// updates with no record, so the pass never pulls it, and applied records
    /// only show on a re-read. A never-pulled body is fetched with its loading
    /// state, as desktop pulls the note on screen first (#3253); a failed
    /// fetch is not repeated until the user asks. Offline is not an error for a
    /// present body: the local copy stays.
    ///
    /// Joins the open's read when the page has not read the note (on open, or
    /// after a cancelled walk), and a pass does not cancel it. That read
    /// already holds what came before it, so the page's own refresh reads
    /// again only when the pull lands something (#5247).
    @discardableResult
    func refreshFromRemote() async -> Bool {
        var stale = hasLoaded && !openAwaitsRefresh
        let read = await opened()
        openAwaitsRefresh = false
        await read?.value
        // A later pass restarted the page's task; its refresh pulls instead.
        guard !Task.isCancelled, hasLoaded else { return false }
        // A binary note has no body to pull: its file is the content.
        if let shown = file?.attachmentId {
            if fileFetch == .idle { await fetchFile() }
            if stale { await load(quietly: true) }
            // A peer replaced the file while it was open: fetch the new one now.
            if let now = file?.attachmentId, now != shown { fileFetch = .idle; await fetchFile() }
            return stale
        }
        if case let .ready(detail) = phase, !detail.body.present {
            guard fetch == .idle else { return false }
            await fetchBody()
            return true
        }
        if let filler, fetch != .fetching,
           case let .ready(detail) = phase, detail.body.present {
            do {
                let pulled = try await filler.fetchNoteBody(noteId: route.id)
                stale = stale || pulled.updates > 0 || pulled.baselines > 0
            } catch {
                Log.sync.debug("a note body could not be pulled")
            }
        }
        if stale { await load(quietly: true) }
        return stale
    }

    /// Reads and walks the note when the page has not, or joins that read
    /// while it runs. Leaving the page cancels it; a sync pass does not.
    func open() async {
        guard let read = await opened() else { return }
        await withTaskCancellationHandler { await read.value } onCancel: { read.cancel() }
    }

    /// The open's read: the one running, a new one when the page has not
    /// read the note, or `nil`. One that leaving the page cancelled ends first.
    private func opened() async -> Task<Void, Never>? {
        while let read = opening, read.isCancelled { await read.value }
        if let opening { return opening }
        guard !hasLoaded else { return nil }
        openAwaitsRefresh = true
        let read = Task {
            await load()
            opening = nil
        }
        opening = read
        return read
    }

    /// The rendered body, read after the summary so the title and the dates
    /// are on screen while the blocks are still being walked.
    ///
    /// A failure here is **not** a failure of the note: the summary and the
    /// text preview are already loaded, so the screen falls back to the
    /// preview rather than replacing a readable note with an error.
    private func loadBlocks() async {
        let generation = landedWrites()
        do {
            let read = try await reader.blocks(id: route.id) ?? []
            blocksGeneration = generation
            blocks = read
        } catch {
            // Cancelled, not failed: keep the blocks being edited on screen.
            // With no walk answered yet, the next open walks again (#5247).
            if Task.isCancelled { hasLoaded = blocksWalked; return }
            let mapped = ErrorMapping.userFacing(error)
            Log.storage.error("this note's blocks could not be walked", .code(mapped.code))
            blocksGeneration = generation
            blocks = []
        }
        blocksWalked = true
        // A body not on this device yet has no blocks to find in: a find
        // request waits for the pull instead of reporting no match.
        if case let .ready(detail) = phase { blocksRead = detail.body.present }
        if let read = await readTables() { tables = read }
        await loadAttachments()
        if let read = await readComments() { comments = read }
        if let read = await readTaskCards() { taskCards = read }
    }

    /// Binds every attachment-bearing block in the body.
    ///
    /// Eager, like the tables and for the same reason: the resolver is async
    /// and a SwiftUI body is not, and a picture that appeared a frame late
    /// would reflow the note under the reader's eyes.
    func loadAttachments() async {
        var bound: [String: BlockAttachment] = [:]
        for url in Self.attachmentUrls(in: blocks) {
            do {
                bound[url] = try await reader.attachmentForBlock(id: route.id, url: url)
            } catch {
                if Task.isCancelled { return }
                let mapped = ErrorMapping.userFacing(error)
                Log.storage.error("an attachment could not be resolved", .code(mapped.code))
            }
        }
        attachments = bound
    }

    /// The tags and properties, read after the note for the same reason the
    /// blocks are: the title and the dates belong on screen first, and a
    /// failure here is not a failure of the note.
    private func loadMetadata() async {
        do {
            metadata = try await reader.metadata(id: route.id)
        } catch {
            if Task.isCancelled { return }
            let mapped = ErrorMapping.userFacing(error)
            Log.storage.error("this note's tags and properties could not be read", .code(mapped.code))
            // Left unread rather than emptied. An empty row would say this
            // note has no tags, which is a claim this screen cannot make.
            metadata = nil
        }
    }

    /// The row's placeholder, matched exactly. An id identifies content and
    /// reads as noise, so an untitled note says so in words on both screens.
    /// Every note in this vault, for the wiki-link search (N602).
    ///
    /// Read once when the note opens rather than on every keystroke in the
    /// search field: a vault can hold thousands and the list does not change
    /// while a menu is open.
    private(set) var vaultNotes: [NoteSummary] = [] {
        didSet {
            vaultTitles = Set(vaultNotes.map { $0.title.lowercased() })
            vaultPaths = Set(vaultNotes.map { WikiTarget.pathKey(of: $0) })
        }
    }
    private(set) var vaultTitles: Set<String> = []
    /// Each note's case-folded `folder/title` path, for path-form links.
    private(set) var vaultPaths: Set<String> = []

    /// Every tag's chosen colour, lowercased name to palette name or hex, so
    /// a chip is the colour desktop draws it. Empty until read, which draws
    /// each tag in the colour its name hashes to — desktop's own default.
    private(set) var tagColors: [String: String] = [:]
    /// Every tag in the vault, most used first, for the tag field's search.
    private(set) var vaultTagNames: [String] = []

    /// Loads once per screen. `.task` fires again whenever the view is
    /// re-identified, and re-reading a body costs an FFI crossing and a CRDT
    /// apply for an answer the screen already holds.
    func loadIfNeeded() async {
        guard !hasLoaded else { return }
        await reload()
    }

    /// What the retry button and every post-edit refresh call. A note already
    /// on screen re-reads in place: dropping to `.loading` would tear down the
    /// page, and with it any sheet open on it (a date picker, the link sheet).
    func reload() async {
        if case .ready = phase {
            await load(quietly: true)
        } else {
            await load()
        }
    }

    /// `quietly` keeps the page on screen, so a post-sync refresh does not flash.
    private func load(quietly: Bool = false) async {
        hasLoaded = true
        if !quietly {
            phase = .loading
            // A body that just downloaded waits for its own walk (#5247).
            blocksWalked = false
        }
        let detail: NoteDetail?
        do {
            detail = try await reader.read(id: route.id)
        } catch {
            // A cancelled page task, whose queued read `CoreExecutor` refuses.
            // Not unreadable: keep the page, and an open with no read reads again.
            if Task.isCancelled {
                if phase == .loading { hasLoaded = false }
                return
            }
            let mapped = ErrorMapping.userFacing(error)
            Log.storage.error("this note could not be read", .code(mapped.code))
            // Retryable, so the next attempt is a real attempt.
            hasLoaded = false
            // **Not** `.missing`. The note may be here and may hold anything.
            phase = .unreadable(mapped)
            return
        }
        guard let detail else {
            Log.storage.info("a note route resolved to no note")
            phase = .missing
            return
        }
        // No detail at all. A character count is not text, but it is a
        // measurement of one, and `LogDetail` has no shape that says "the body
        // was present" without also saying how long it is.
        Log.storage.info("read one note")
        // Before `.ready`, so a binary note never draws as a missing body.
        await loadFile()
        phase = .ready(detail)
        await loadBlocks()
        await loadMetadata()
        guard let notes = await readVaultNotes() else { return }
        vaultNotes = notes
        if let tags = await readVaultTags() {
            tagColors = tags.colors
            vaultTagNames = tags.names
        }
    }
}
