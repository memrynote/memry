import Foundation
import MemryCore

// T237, the seam half. **The call site spec-defect 136 is about.**
//
// `Vault` and `Notes` are five local reads over a SQLite database, and until
// T236 exported the pull, nothing on the FFI surface ever put a row in it. A
// phone that had never synced opened an empty database and correctly reported
// "no notes" against an account holding ninety-four. T236 exported it; this
// file is what calls it, and `VaultFillView` is where a user meets it.
//
// **Blocking versus async is contract, not detail** (spec-defect 90).
// `Vault.sync(session:)` and `VaultSync.isFirstSyncComplete()` block — the
// second is one row of the local `meta` table and makes **no request** — so
// both go on `CoreExecutor`. `firstSync` and `fetchNoteBody` suspend, so they
// are awaited directly: parking a queue thread on tens of network round trips
// would stall every other core call in the process behind them.
//
// **There is no Cancel anywhere over `firstSync`** (spec-defect 108:
// `rust_future_cancel` appears zero times in the bindings). The shell may
// abandon the *UI* — SwiftUI cancels the `.task` when the view goes away — but
// the run continues to completion or to its first error. A Cancel button would
// be a lie. What makes that bearable is that every pass is durable as it goes,
// so a run killed with the process resumes at the last thing it wrote.
//
// **Read-only.** Nothing here pushes, seals or drains an outbox, because
// nothing exported can: `VaultSync` is the pull half deliberately (known bug 2
// — a client that pushes a field-merged type without pulling first destroys a
// concurrent peer's field, and no later pass repairs it).
//
// **No note id, vault id or title reaches a log** (Constitution II). `Log`
// takes a `StaticString` and a closed `LogDetail`; a count and an error code
// are the only things sayable about a sync here.

/// The read-only pull over one opened vault.
///
/// A three-method dependency rather than `VaultSync` itself, so a screen test
/// can script a pull — including a partial failure — without a network, and so
/// the shell never holds a type it could accidentally call a write on.
protocol VaultFilling: Sendable {
    /// Whether this device has already finished a first sync for this vault.
    ///
    /// **Makes no request.** That is the whole point of asking: the entry gate
    /// decides whether to show a setting-up screen without going near the
    /// network, so a phone in a lift does not sit on a spinner to be told it
    /// was already done.
    func isFirstSyncComplete() async throws -> Bool

    /// The first sync: refs, then metadata newest first, then bodies for the
    /// recent window (data-model §C.3, FR-028).
    ///
    /// - Parameter progress: called on the main actor for every tick. **It is
    ///   never awaited from inside the core's synchronous callback** — see
    ///   ``SyncProgressRelay``, which is the whole reason this parameter is a
    ///   `@MainActor` closure rather than the core's own listener type.
    ///
    /// **A partial run never leaves a vault looking empty.** Metadata lands
    /// before bodies and each pass is durable as it goes, so a throw part way
    /// through leaves the notes that did arrive visible and readable. The
    /// caller must render the reason **beside** those notes, never instead of
    /// them.
    func firstSync(
        progress: @escaping @MainActor @Sendable (SyncProgress) -> Void
    ) async throws -> FirstSyncSummary

    /// One note's body, on demand (chapter 07 §7.8 – §7.11).
    ///
    /// **Not an extra.** `firstSync` pulls bodies only for the recent window
    /// (chapter 10 §10.6.1), so an older note arrives with its metadata and no
    /// body and `Notes.read` answers `NoteBody { present: false }`. Without
    /// this call that note could never become readable, which is spec-defect
    /// 136 one layer down, at note granularity.
    ///
    /// Throws `SyncError.UnknownNote` for a note this vault holds no **live**
    /// record of. That refusal is **permanent**; no copy may call it retryable.
    func fetchNoteBody(noteId: String) async throws -> BodyFetchSummary

    /// Fetches one attachment's bytes (chapter 14, FR-045).
    ///
    /// - Parameter reachable: **the shell's observation, not its policy.**
    ///   Only the shell can see the current path; the core decides what that
    ///   means, so the unmetered-by-default rule and its per-item override
    ///   live in one place rather than being re-argued here.
    ///
    /// **A deferred fetch is not a failure.** A picture waiting for an
    /// unmetered path is FR-045 working, and the summary says so rather than
    /// throwing; a caller that showed an error there would report a fault for
    /// correct behaviour.
    func fetchAttachment(
        attachmentId: String,
        reachable: Reachable
    ) async throws -> AttachmentFetchSummary

    /// Uploads a file and attaches it to a note (chapter 14 §14.2–§14.5).
    ///
    /// One call for the whole chain, because every step is useless alone: a
    /// shell that could stop between them would leave chunks in R2 that no
    /// manifest names.
    ///
    /// - Returns: the new attachment id.
    func uploadAttachment(
        noteId: String,
        filename: String,
        mimeType: String,
        bytes: Data
    ) async throws -> String

    /// Detaches an attachment and releases its bytes (§14.8).
    ///
    /// **Dereferencing is not optional.** A client that dropped the reference
    /// without telling the server would leak the user's own quota, silently
    /// and permanently. The core also checks whether another note still holds
    /// the attachment before releasing anything.
    func detachAttachment(noteId: String, attachmentId: String) async throws

    /// One pull-then-push pass (spec 004 TP028a): records, the bodies they
    /// touched, then the outbox. The only way a phone write reaches another
    /// device. Awaited directly, never queued, like ``firstSync``.
    func syncNow() async throws -> SyncPassSummary

    /// Outbox rows still waiting (spec 006 ST15).
    func pendingChanges() async throws -> UInt32
}

extension VaultFilling {
    func pendingChanges() async throws -> UInt32 { 0 }
}

/// The production filler: the core's own `VaultSync`.
struct CoreVaultFiller: VaultFilling {
    func syncNow() async throws -> SyncPassSummary {
        try await sync.syncNow()
    }

    func pendingChanges() async throws -> UInt32 {
        let sync = sync
        return try await executor.run { try sync.pendingChanges() }
    }

    private let sync: VaultSync
    private let executor: CoreExecutor

    init(sync: VaultSync, executor: CoreExecutor) {
        self.sync = sync
        self.executor = executor
    }

    /// Blocking, so it goes on the serial core queue. One local row, no
    /// request — the gate can ask this offline.
    func isFirstSyncComplete() async throws -> Bool {
        let sync = sync
        return try await executor.run { try sync.isFirstSyncComplete() }
    }

    /// Awaited directly and **not** queued (spec-defect 90). A no-op pass over
    /// a ninety-four-note vault already costs thirty-odd seconds; a queue
    /// thread parked on that would stall every blocking core call behind it.
    func firstSync(
        progress: @escaping @MainActor @Sendable (SyncProgress) -> Void
    ) async throws -> FirstSyncSummary {
        try await sync.firstSync(progress: SyncProgressRelay(receive: progress))
    }

    /// Awaited directly for the same reason, though this one is a handful of
    /// round trips rather than tens.
    func fetchNoteBody(noteId: String) async throws -> BodyFetchSummary {
        try await sync.fetchNoteBody(noteId: noteId)
    }

    func fetchAttachment(
        attachmentId: String,
        reachable: Reachable
    ) async throws -> AttachmentFetchSummary {
        try await sync.fetchAttachment(attachmentId: attachmentId, reachable: reachable)
    }

    func uploadAttachment(
        noteId: String,
        filename: String,
        mimeType: String,
        bytes: Data
    ) async throws -> String {
        try await sync.uploadAttachment(
            noteId: noteId,
            filename: filename,
            mimeType: mimeType,
            bytes: bytes
        )
    }

    func detachAttachment(noteId: String, attachmentId: String) async throws {
        try await sync.detachAttachment(noteId: noteId, attachmentId: attachmentId)
    }
}

/// Carries the core's progress ticks to the main actor **without waiting for
/// it**.
///
/// `SyncProgressListener` is **synchronous by contract**: the core calls it
/// from inside the pass that is reporting, on a Rust thread, while that pass is
/// mid-flight. So an implementation that blocks stalls the sync it is
/// measuring, and an implementation that awaits is worse — it would suspend a
/// thread the core owns.
///
/// `DispatchQueue.main.async` is therefore the mechanism and not a detail. It
/// is deliberately **not** `Task { @MainActor in … }`: an unstructured task per
/// tick over a long run is a lot of tasks nobody holds, and the enqueue itself
/// is the only thing that has to happen on Rust's thread. The
/// `assumeIsolated` is inside the main-queue block, where it is a statement of
/// fact rather than an assumption — it is never applied at the call site,
/// which is a Rust thread. `SyncProgressRelayTests` asserts the non-blocking
/// half over a **blocked** main actor, with a bound, so it fails rather than
/// hangs.
final class SyncProgressRelay: SyncProgressListener, @unchecked Sendable {
    private let receive: @MainActor @Sendable (SyncProgress) -> Void

    init(receive: @escaping @MainActor @Sendable (SyncProgress) -> Void) {
        self.receive = receive
    }

    /// Enqueues and returns. Nothing below this line may wait on anything.
    func progress(progress: SyncProgress) {
        let receive = receive
        DispatchQueue.main.async { MainActor.assumeIsolated { receive(progress) } }
    }
}

/// Mints the pull for one opened vault.
///
/// A dependency rather than a call, because `VaultSync` needs three things
/// held in three places: the database `Vault` opened, the `AuthSession` that
/// owns the one token manager, and the master key under it. Only the
/// composition root has all three.
protocol VaultFillerMinting: Sendable {
    func filler(for vault: Vault) async throws -> any VaultFilling
}

/// The production mint.
///
/// **It holds the concrete `AuthSession`, not `RevocationWatch`.**
/// `Vault.sync(session:)` takes the core class, and there is no protocol to
/// hand it — so a revocation is not observed through this path. It does not
/// need to be: a revoked device's pull fails with `ApiError.DeviceRevoked`
/// inside `SyncError.Api`, which `ErrorMapping` already renders, and the watch
/// on every *other* authenticated call is what performs the wipe.
///
/// **The `VaultSync` this returns holds an `Arc<AuthSession>`**, so a shell
/// that keeps one alive keeps the session alive. That is why the filler is
/// held by `VaultSelectionViewModel` and dropped when it leaves `registered`:
/// `AuthRootView.route(for:)` sets `vaults = nil` on a sign-out or a
/// revocation, which drops the model, which drops the filler, which drops the
/// `VaultSync`.
struct CoreVaultFillerMint: VaultFillerMinting {
    private let session: AuthSession
    private let executor: CoreExecutor

    init(session: AuthSession, executor: CoreExecutor) {
        self.session = session
        self.executor = executor
    }

    /// `sync(session:)` blocks and does no I/O at all, so it goes on the core
    /// queue beside every other blocking call rather than being awaited.
    func filler(for vault: Vault) async throws -> any VaultFilling {
        let session = session
        let sync = try await executor.run { vault.sync(session: session) }
        return CoreVaultFiller(sync: sync, executor: executor)
    }
}
