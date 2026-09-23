import Foundation
import MemryCore
import Observation

// T157, the state half. One note, read-only.
//
// **This is a preview, not a render, and it is the placeholder T176 replaces**
// (spec-defect 125, Kaan's decision). `NoteBody.text` is `extract_text` output
// — chapter 12 §12.1's *only* text operation — so a heading arrives as `# `, a
// bullet as `- `, and bold, links and code fences arrive as nothing at all.
// Nothing here parses or serialises markdown, because §12.1.2 forbids a
// non-editor client from doing either: it "owns `extract_text` and nothing
// else". A faithful render needs `Document::encode_state()` exported **and**
// the editor bundle hosted through `EditorHost`, and per spec-defect 107 the
// core can be handed neither today.
//
// **Four outcomes, four screens, and no arm shared between them.** This is the
// single most likely bug in this task, so the distinction is carried by types
// rather than by care:
//
//   * `read` **threw** — the note may exist and may hold anything. `.unreadable`.
//   * `read` returned **nil** — this vault holds no live note by that id.
//     `.missing`. A restored navigation path lands here, and so does a note
//     deleted on another device.
//   * the body is **not on this device** — `present == false`. `.notPulled`.
//   * the body is **empty** — `present == true`, no text. `.empty`.
//
// The first two are `Phase` cases; the last two are ``NoteBodyPreview`` cases,
// because they are facts about a note that was read successfully and so must
// still show its title and its dates. Collapsing any pair would report an
// unread note as an empty one, which is the failure `domain/reads.rs` says the
// whole module was written against.
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

    /// The current network path, for FR-045's metered policy.
    ///
    /// Optional because nothing constructs a `PathReachability` in production
    /// yet. The **policy** is never here either way — it is the core's, in
    /// `may_download` — so this only supplies the observation.
    let reachability: (any Reachability)?

    private(set) var phase: Phase = .loading
    private(set) var fetch: Fetch = .idle
    /// The rendered body. Empty means "nothing to draw", which the screen
    /// resolves against `preview`: a body that is present and empty, a body
    /// that was never pulled, and a reader that cannot walk blocks are three
    /// different facts and only the first two are the note's.
    private(set) var blocks: [Block] = []
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
    /// The note's tags and typed properties, or `nil` while they are unread.
    ///
    /// `nil` and "read, and it has none" are different: the first draws
    /// nothing because the answer has not arrived, the second draws nothing
    /// because there is nothing — and only the first may change on its own.
    private(set) var metadata: NoteMetadata?
    /// The note's review comments and suggestions (N604), read only.
    private(set) var comments: [ReviewComment] = []
    /// Each task block's task, by task id, for the row desktop draws.
    private(set) var taskCards: [String: TaskCard] = [:]
    private var hasLoaded = false

    init(
        route: NoteRoute,
        reader: any NotesReading,
        filler: (any VaultFilling)? = nil,
        reachability: (any Reachability)? = nil
    ) {
        self.route = route
        self.reader = reader
        self.filler = filler
        self.reachability = reachability
    }

    /// Whether this screen can offer to fetch a body at all. An affordance
    /// that leads nowhere is worse than its absence.
    var canFetchBody: Bool { filler != nil }

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
        guard let filler, fetch != .fetching else { return }
        fetch = .fetching
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
        await load()
    }

    /// The rendered body, read after the summary so the title and the dates
    /// are on screen while the blocks are still being walked.
    ///
    /// A failure here is **not** a failure of the note: the summary and the
    /// text preview are already loaded, so the screen falls back to the
    /// preview rather than replacing a readable note with an error.
    private func loadBlocks() async {
        do {
            blocks = try await reader.blocks(id: route.id) ?? []
        } catch {
            let mapped = ErrorMapping.userFacing(error)
            Log.storage.error("this note's blocks could not be walked", .code(mapped.code))
            blocks = []
        }
        await loadTables()
        await loadAttachments()
        await loadComments()
        await loadTaskCards()
    }

    /// A task block the vault holds no task for draws from its own props.
    private func loadTaskCards() async {
        var cards: [String: TaskCard] = [:]
        for block in blocks where block.kind == "taskBlock" {
            guard let id = block.props.first(where: { $0.name == "taskId" })?.value, !id.isEmpty
            else { continue }
            if let card = try? await reader.task(id: id) { cards[id] = card }
        }
        taskCards = cards
    }

    /// A failure leaves the list empty: not seeing a comment is much smaller
    /// than not seeing the note.
    private func loadComments() async {
        do {
            comments = try await reader.comments(id: route.id)
        } catch {
            let mapped = ErrorMapping.userFacing(error)
            Log.storage.error("this note's review comments could not be read", .code(mapped.code))
            comments = []
        }
    }

    /// Binds every attachment-bearing block in the body.
    ///
    /// Eager, like the tables and for the same reason: the resolver is async
    /// and a SwiftUI body is not, and a picture that appeared a frame late
    /// would reflow the note under the reader's eyes.
    private func loadAttachments() async {
        var bound: [String: BlockAttachment] = [:]
        for url in Self.attachmentUrls(in: blocks) {
            do {
                bound[url] = try await reader.attachmentForBlock(id: route.id, url: url)
            } catch {
                let mapped = ErrorMapping.userFacing(error)
                Log.storage.error("an attachment could not be resolved", .code(mapped.code))
            }
        }
        attachments = bound
    }

    /// Fetches the bytes for every attachment this note is still waiting on,
    /// then re-resolves so the pictures appear **in place**.
    ///
    /// FR-045 asks for exactly this: a picture whose bytes have not arrived
    /// shows a placeholder and "becomes visible on arrival without the note
    /// being recreated". Re-resolving into `attachments` re-renders the
    /// existing views rather than rebuilding the screen, which is what keeps
    /// the reader's scroll position.
    ///
    /// **Deferred is not failure.** On a metered path the core answers
    /// `deferred` and writes nothing; the placeholder simply stays, which is
    /// the feature working rather than an error to report.
    ///
    /// A single failure does not abandon the rest: one unverifiable manifest
    /// must not stop the other pictures in the note from arriving.
    func fetchWaitingAttachments() async {
        guard let filler else { return }
        // The screen passes `PathReachability.forAttachments`. With none, the
        // documented answer for "we have not seen a path" is `.cellular`:
        // usable, metered, and the honest unknown, so an unmetered-only
        // attachment defers rather than spending a stranger's data plan.
        let reachable = reachability?.current() ?? PathReachability.unknownPath

        var landed = false
        for (_, binding) in attachments {
            guard case let .bound(attachment) = binding,
                  attachment.localPath == nil
            else { continue }
            do {
                let summary = try await filler.fetchAttachment(
                    attachmentId: attachment.attachmentId,
                    reachable: reachable
                )
                if summary.downloaded { landed = true }
            } catch {
                let mapped = ErrorMapping.userFacing(error)
                Log.sync.error("an attachment could not be fetched", .code(mapped.code))
            }
        }

        if landed {
            await loadAttachments()
        }
    }

    /// Re-resolves after bytes land, so the picture appears in place.
    func refreshAttachments() async {
        await loadAttachments()
    }

    /// The structure of every table in the body.
    ///
    /// A table that will not read is **left out rather than emptied**, and
    /// the view draws its placeholder: an empty `TableContent` would claim
    /// the note holds a table with no rows, which is a different note.
    private func loadTables() async {
        var loaded: [String: TableContent] = [:]
        for block in blocks where block.kind == "table" {
            guard let blockId = block.id else { continue }
            do {
                if let table = try await reader.table(id: route.id, blockId: blockId) {
                    loaded[blockId] = table
                }
            } catch {
                let mapped = ErrorMapping.userFacing(error)
                Log.storage.error("a table in this note could not be read", .code(mapped.code))
            }
        }
        tables = loaded
    }

    /// The tags and properties, read after the note for the same reason the
    /// blocks are: the title and the dates belong on screen first, and a
    /// failure here is not a failure of the note.
    private func loadMetadata() async {
        do {
            metadata = try await reader.metadata(id: route.id)
        } catch {
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
        }
    }
    private(set) var vaultTitles: Set<String> = []

    /// Every tag's chosen colour, lowercased name to palette name or hex, so
    /// a chip is the colour desktop draws it. Empty until read, which draws
    /// each tag in the colour its name hashes to — desktop's own default.
    private(set) var tagColors: [String: String] = [:]

    /// Loads once per screen. `.task` fires again whenever the view is
    /// re-identified, and re-reading a body costs an FFI crossing and a CRDT
    /// apply for an answer the screen already holds.
    func loadIfNeeded() async {
        guard !hasLoaded else { return }
        await load()
    }

    /// What the retry button calls.
    func reload() async {
        await load()
    }

    private func load() async {
        hasLoaded = true
        phase = .loading
        let detail: NoteDetail?
        do {
            detail = try await reader.read(id: route.id)
        } catch {
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
        phase = .ready(detail)
        await loadBlocks()
        await loadMetadata()
        await loadVaultNotes()
    }

    /// The vault's notes, for the wiki-link search (N602).
    ///
    /// A failure leaves the list empty rather than failing the screen: not
    /// being able to search for a link is much smaller than not being able to
    /// read the note.
    private func loadVaultNotes() async {
        do {
            vaultNotes = try await reader.list()
        } catch {
            Log.storage.error("the vault's notes could not be listed for linking")
            vaultNotes = []
        }
        do {
            var colors: [String: String] = [:]
            for tag in try await reader.tags() {
                if let color = tag.color, !color.isEmpty { colors[tag.name.lowercased()] = color }
            }
            tagColors = colors
        } catch {
            Log.storage.error("the vault's tag colours could not be read")
        }
    }
}
