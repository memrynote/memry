import Foundation
import MemryCore
import Observation

// T156, the state half. Reading one opened vault's folders and notes.
//
// **Read-only, and that is the whole exported surface.** `Notes` exports
// `folders()`, `list()` and `read(id:)` and nothing else: T126 built create,
// rename, move and delete in Rust in Phase 3 and none of it reached the FFI.
// So there is no context menu, no swipe action and no create affordance
// anywhere in this feature — not as a policy, but because the call does not
// exist. T156a is cut.
//
// **Every core call here blocks** (`contracts/core-api.md`, the read slice):
// they are local SQLite reads plus a `yrs` apply, so they go on `CoreExecutor`
// rather than being awaited directly. Nothing offers a Cancel over one —
// `rust_future_cancel` appears zero times in the bindings (spec-defect 108),
// and a blocking call never had anything to cancel.
//
// **Two crossings per load, and never one per row.** `list()` is a local read
// but still crosses the FFI, and a 94-note vault is a realistic size. The two
// snapshots are folded into a `VaultOutline` once, and every row afterwards is
// a value read.
//
// **Empty, empty-folder and unreadable are three screens, by construction.**
// They are three `Phase` cases with no shared arm, and a read that throws
// cannot reach `.empty` because `.empty` is only assigned where both reads
// returned. A `GET /sync/vaults` reader once `filter_map`-ed a row away and
// told an account holding four vaults it had none; the same shape here would
// tell a user with notes that they have none.
//
// **No note title, id, folder path or body text reaches a log** (Constitution
// II). There is nowhere to put one: `Log` takes a `StaticString` and a closed
// `LogDetail`, so a count is the only thing that can be said.

/// One vault's read-only content surface.
///
/// A two-method dependency rather than `Notes` itself, so a test can script an
/// answer — including a failure — without a database.
protocol NotesReading: Sendable {
    /// - Returns: every configured folder, parent before child. **Empty means
    ///   empty.** A projection that could not be read throws.
    func folders() async throws -> [FolderSummary]
    /// - Returns: every live note, newest first. No folder filter exists on
    ///   the exported surface, which is why the grouping is done here.
    func list() async throws -> [NoteSummary]
    /// One note and its body, for T157's read surface.
    ///
    /// - Returns: `nil` when this vault holds no live note by that id.
    ///   **`nil` is not an error and not an empty note**: a note that exists
    ///   and cannot be read throws, and a note that exists and holds no text
    ///   returns a `NoteBody`. Three answers, three screens.
    func read(id: String) async throws -> NoteDetail?
    /// One note's tags, typed properties and aliases.
    ///
    /// - Returns: `nil` for "no such note", exactly as `read` does. **Empty
    ///   lists are not absence**: a note that carries no tag is a different
    ///   screen from a note that is gone.
    func metadata(id: String) async throws -> NoteMetadata?
    /// What a `[[wiki link]]` points at.
    ///
    /// - Returns: `nil` for a link naming no note. That is a **broken link,
    ///   not a failure** — a link carries a title, so it can name a note that
    ///   does not exist, and the screen says so rather than showing an error.
    func resolveWikiTarget(_ target: String) async throws -> String?
    /// The same note's body as blocks, for rendering rather than previewing.
    ///
    /// - Returns: `nil` for "no such note", exactly as `read` does. An **empty
    ///   array** is a body this device holds that contains nothing — the same
    ///   distinction `NoteBody.present` draws one level down, and the reason
    ///   the two are not collapsed here.
    func blocks(id: String) async throws -> [Block]?
    /// One table's rows, cells and column widths, by the block id
    /// ``blocks(id:)`` reported for the `table` block.
    ///
    /// - Returns: `nil` when there is no such table — no such note, or a
    ///   block id holding something else. A flat block list carries one
    ///   dimension and a table is two, which is why this is a second read
    ///   rather than a field.
    func table(id: String, blockId: String) async throws -> TableContent?
    /// Every attachment this vault knows one note references.
    ///
    /// - Returns: an **empty list is not "this note has no attachments"**. It
    ///   is also what a note whose references have never arrived looks like,
    ///   because an absent `attachmentReferences` means "this sender does not
    ///   know" (chapter 13 §13.4).
    func attachments(id: String) async throws -> [CachedAttachment]
    /// What one body block's `url` points at.
    ///
    /// A block carries a vault-relative path rather than an attachment id, so
    /// the core binds the two by the basename of the signed manifest's
    /// filename. Four answers, because a remote image is ordinary content and
    /// an ambiguous name is refused rather than guessed.
    func attachmentForBlock(id: String, url: String) async throws -> BlockAttachment
}

/// The production reader: the core's own `Notes`, over the shell's one serial
/// core queue.
struct CoreNotesReader: NotesReading {
    private let vault: Vault
    private let executor: CoreExecutor

    init(vault: Vault, executor: CoreExecutor) {
        self.vault = vault
        self.executor = executor
    }

    /// `vault.notes()` is a clone of the same handle rather than a second
    /// connection (`core-api.md`), so taking it inside the queued block costs
    /// nothing and keeps every FFI crossing on the one queue.
    func folders() async throws -> [FolderSummary] {
        let vault = vault
        return try await executor.run { try vault.notes().folders() }
    }

    func list() async throws -> [NoteSummary] {
        let vault = vault
        return try await executor.run { try vault.notes().list() }
    }

    /// Blocking like its siblings — a SQLite read plus a `yrs` apply — so it
    /// goes on the same serial queue and offers no Cancel (spec-defect 108).
    func read(id: String) async throws -> NoteDetail? {
        let vault = vault
        return try await executor.run { try vault.notes().read(id: id) }
    }

    /// Blocking for the same reason and on the same queue. It rebuilds the
    /// **same** document `read` does, from the same update log, so the two
    /// cannot disagree about what has arrived.
    func blocks(id: String) async throws -> [Block]? {
        let vault = vault
        return try await executor.run { try vault.notes().blocks(id: id) }
    }

    /// Same queue, same document, same reasons.
    func table(id: String, blockId: String) async throws -> TableContent? {
        let vault = vault
        return try await executor.run { try vault.notes().table(id: id, blockId: blockId) }
    }

    func attachments(id: String) async throws -> [CachedAttachment] {
        let vault = vault
        return try await executor.run { try vault.notes().attachments(id: id) }
    }

    func attachmentForBlock(id: String, url: String) async throws -> BlockAttachment {
        let vault = vault
        return try await executor.run {
            try vault.notes().attachmentForBlock(id: id, url: url)
        }
    }

    /// One indexed row plus the vault's property definitions — no CRDT apply,
    /// so it is the cheapest of these reads and still goes on the same queue.
    func metadata(id: String) async throws -> NoteMetadata? {
        let vault = vault
        return try await executor.run { try vault.notes().metadata(id: id) }
    }

    /// A title lookup, then an alias pass. Blocking like its siblings.
    func resolveWikiTarget(_ target: String) async throws -> String? {
        let vault = vault
        return try await executor.run { try vault.notes().resolveWikiTarget(target: target) }
    }
}

@MainActor
@Observable
final class VaultBrowseViewModel {
    /// Where the screen is. Four cases, and the two that mean "nothing to
    /// show" are deliberately not one: a vault that holds nothing is a fact,
    /// a vault that would not read is a failure.
    enum Phase: Equatable {
        case loading
        case ready(VaultOutline)
        /// Both reads succeeded and both were empty.
        case empty
        /// A read threw. **Never rendered as an empty vault.**
        case unreadable(UserFacingError)
    }

    private(set) var phase: Phase = .loading

    /// The reader in use. Internal so the wiring suite can assert that the
    /// production graph holds the **core** reader rather than something that
    /// behaves like it — five tiers shipped in Phase 3 fully tested behind
    /// fakes and never called.
    let reader: any NotesReading

    /// T237. The on-demand body fetch, handed down to `NoteReadView`.
    ///
    /// `nil` when this screen has no session to pull through. A note outside
    /// the first sync's thirty-day body window then stays unreadable, which is
    /// honest — the alternative is a button that cannot do anything.
    let filler: (any VaultFilling)?

    /// The write surface, or `nil` for a screen that has none.
    ///
    /// `nil` is not a policy either: a caller with no keychain to derive this
    /// device's identity from cannot write, and the affordances are hidden
    /// rather than shown failing. See `VaultWrite.swift`.
    let writer: (any NotesWriting)?

    /// Full-text search over this vault, or `nil` when the index could be
    /// neither opened nor rebuilt.
    ///
    /// `nil` does not fail the screen: browsing a vault whose index is broken
    /// still works, and the search field falls back to matching titles in the
    /// outline this screen already holds.
    let search: VaultSearchViewModel?

    /// The last failed write, for the screen to show and dismiss. Separate
    /// from ``phase`` because a failed write leaves the vault readable: the
    /// outline is still true, only the write did not happen.
    var writeFailure: UserFacingError?

    private var hasLoaded = false

    init(
        reader: any NotesReading,
        filler: (any VaultFilling)? = nil,
        writer: (any NotesWriting)? = nil,
        search: (any VaultSearching)? = nil
    ) {
        self.reader = reader
        self.filler = filler
        self.writer = writer
        self.search = search.map { VaultSearchViewModel(search: $0) }
    }

    /// The production initializer. `AuthRootView` -> `VaultListView` ->
    /// `VaultFillView` -> `NotesListView` reaches this and nothing else.
    convenience init(
        vault: Vault,
        executor: CoreExecutor,
        filler: (any VaultFilling)? = nil,
        store: (any SecureStore)? = nil
    ) {
        self.init(
            reader: CoreNotesReader(vault: vault, executor: executor),
            filler: filler,
            // No store, no identity, no writes — and no buttons offering them.
            writer: store.map { CoreNotesWriter(vault: vault, store: $0, executor: executor) },
            // A vault whose index will not open is still a vault worth
            // browsing, so this failure is absorbed into "no full-text search"
            // rather than into "no screen".
            search: try? CoreVaultSearch(vault: vault, executor: executor)
        )
    }

    /// The loaded hierarchy, or `nil` in every other phase.
    ///
    /// A pure read of the snapshot: route resolution uses it, so a restored
    /// navigation path resolves without a row existing.
    var outline: VaultOutline? {
        guard case let .ready(outline) = phase else { return nil }
        return outline
    }

    /// Loads once per screen. `.task` fires again whenever the view is
    /// re-identified, and re-reading the whole vault each time would be two
    /// FFI crossings for a screen that already has its answer.
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
        let folders: [FolderSummary]
        let notes: [NoteSummary]
        do {
            folders = try await reader.folders()
            notes = try await reader.list()
        } catch {
            let mapped = ErrorMapping.userFacing(error)
            Log.storage.error("this vault's folders and notes could not be read", .code(mapped.code))
            // Retryable, so the next attempt is a real attempt.
            hasLoaded = false
            // **Not** `.empty`. The vault may hold ninety-four notes.
            phase = .unreadable(mapped)
            return
        }
        Log.storage.info("read a vault outline", .count(notes.count))
        guard !folders.isEmpty || !notes.isEmpty else {
            phase = .empty
            return
        }
        phase = .ready(.build(folders: folders, notes: notes))
    }
}
