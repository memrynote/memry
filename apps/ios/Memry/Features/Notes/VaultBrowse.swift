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

    private var hasLoaded = false

    init(reader: any NotesReading) {
        self.reader = reader
    }

    /// The production initializer. `AuthRootView` -> `VaultListView` ->
    /// `NotesListView` reaches this and nothing else.
    convenience init(vault: Vault, executor: CoreExecutor) {
        self.init(reader: CoreNotesReader(vault: vault, executor: executor))
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
