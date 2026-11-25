import Foundation
import MemryCore
import Observation
import UIKit

// T155. Choosing which vault this phone opens (FR-021, data-model §C.2).
//
// **An empty list and an unreadable list are different screens, by
// construction.** They are two `Phase` cases with no shared arm, so there is no
// line here where one can decay into the other. The rule has teeth: the reader
// behind `GET /sync/vaults` once used a `filter_map` and reported "this account
// has no vaults" against an account holding four. The core now fails the whole
// read on a row it cannot parse, and this file keeps the two facts apart on the
// way to the screen.
//
// **The choice is offered only when there is one** (§C.2: `-> VaultChoice`
// "account holds more than one vault and none is chosen"). One vault is opened
// without asking, because a list of one is not a choice, it is a tap the user
// has to make to get where they were always going.
//
// **`VaultChoice` is not an exported core state.** §C.2's vault-lock machine
// has no binding of any kind — `VaultChoice` appears zero times in the
// generated Swift — so this phase is the shell's, held here, and it drives the
// core only through `vaults()` and `Vault.open`. Reported as a gap rather than
// modelled as if the edge were being driven.
//
// **No vault id reaches a log** (Constitution II). `Log`'s surface is a
// `StaticString` plus a closed `LogDetail`, so there is nowhere to put one, and
// a count is the only thing worth saying anyway.

extension Notification.Name {
    /// A vault's sync pass got through, so the server answered. The vault
    /// screen re-reads the registry when it is showing an offline notice.
    static let vaultSyncPassSucceeded = Notification.Name("memry.vaultSyncPassSucceeded")
}

@MainActor
@Observable
final class VaultSelectionViewModel {
    /// Where the screen is. Every case is a distinct render, and the two
    /// failures are distinct from each other as well: a list that would not
    /// load is not a vault that would not open.
    enum Phase: Equatable {
        case loading
        /// More than one vault, and none chosen yet — §C.2's `VaultChoice`.
        case choosing([VaultSummary])
        /// The account genuinely holds no vault. Not a failure.
        case empty
        /// The registry could not be read. Not an empty account.
        case unreadable(UserFacingError)
        /// Offline, and this device has opened no vault yet (#5524).
        case offline
        case opening(VaultSummary)
        case opened(VaultSummary)
        case failedToOpen(VaultSummary, UserFacingError)
    }

    private(set) var phase: Phase = .loading

    /// Why the registry could not be read while the last vault opened from
    /// this device anyway. Shown over the vault, never instead of it (#5524).
    private(set) var registryNotice: UserFacingError?

    /// The vault open offline is gone from the account. Its files stay on
    /// this device; the screen says so, and offers to export them, until
    /// dismissed or left (#5600).
    private(set) var removedVault: RemovedVaultExport?

    /// A re-read is out. Other triggers wait for its answer instead of
    /// queueing reads of their own, and Try again shows it.
    private(set) var isRecheckingRegistry = false

    /// Bumped by every ``load()`` and ``open(_:source:)``. A registry read
    /// that started under an older value belongs to a screen that has since
    /// been replaced, so its answer is dropped. The phase cannot say this: a
    /// reload that ends where it started (the same vault, offline again) has
    /// the same phase and notice as the screen the stale read was for.
    private var loadGeneration = 0

    /// The latest registry read. ``readRegistry()`` runs the next one after
    /// it, because the signed-in registry writes (it creates and registers
    /// the local vault) and two overlapping calls would race those writes.
    private var registryReads: Task<Void, Never>?

    /// The open handle, for the screens that read it (T156, T157).
    ///
    /// Dropping it closes the connection, which is why switching vaults
    /// re-enters ``open(_:)`` rather than reusing anything: the next open of
    /// the same vault creates fresh `-wal`/`-shm` files and must sweep them
    /// again. See `VaultOpening.swift`.
    private(set) var vault: Vault?

    /// T237. The read-only pull over the vault this screen opened.
    ///
    /// `nil` until a vault is open, and `nil` afterwards when no ``mint`` was
    /// supplied. Held here rather than inside the browse screen because it is
    /// per-vault and per-session: dropping this model on a sign-out drops the
    /// filler, which drops the `VaultSync`, which drops its `Arc<AuthSession>`.
    /// See `VaultFilling.swift`.
    private(set) var filler: (any VaultFilling)?

    private let registry: any VaultRegistry
    private let opener: any VaultOpening
    /// `nil` for a caller with no session to pull through — the screen then
    /// browses whatever is already on this phone, which before T237 was the
    /// only behaviour there was (spec-defect 136).
    ///
    /// Internal rather than private for the same reason ``reader`` is on the
    /// browse model: the wiring suite asserts that the **production** graph
    /// carries `CoreVaultFillerMint` rather than something that behaves like
    /// one. A composition root that quietly stopped passing it would put the
    /// defect straight back, and nothing else would notice.
    let mint: (any VaultFillerMinting)?

    /// The keychain the browse screen derives this device's write identity
    /// from.
    ///
    /// `nil` for a caller that has none, and the browse screen is then
    /// read-only: no create button, no rename, no delete. Carried here rather
    /// than built inside the browse screen for the reason ``mint`` is — the
    /// composition root owns what the production graph runs on.
    let secureStore: (any SecureStore)?

    /// The account session Settings calls (devices, storage, plan, vault
    /// deletion; spec 006). The watched one, so a revocation learned there
    /// wipes the phone like any other call.
    let session: (any AuthSessionProtocol)?

    /// Whether a vault may sync. `false` for the local vault while the
    /// account does not hold it: it opens with no filler, so no pass and no
    /// socket reach a server that would refuse it.
    private let syncable: @Sendable (String) -> Bool

    /// Where the last open vault is remembered. Injected so a test reads and
    /// writes its own, rather than the process-wide one every other test and
    /// the running app share.
    private let snapshot: LaunchSnapshot

    /// A vault's folder on this device, for exporting a removed one.
    private let removedVaultSource: @Sendable (String) throws -> URL

    init(
        registry: any VaultRegistry,
        opener: any VaultOpening,
        mint: (any VaultFillerMinting)? = nil,
        secureStore: (any SecureStore)? = nil,
        session: (any AuthSessionProtocol)? = nil,
        snapshot: LaunchSnapshot = .shared,
        syncable: @escaping @Sendable (String) -> Bool = { _ in true },
        removedVaultSource: @escaping @Sendable (String) throws -> URL = {
            try VaultFiles(emitter: CoreEventEmitter { _ in }).vaultDirectory($0)
        }
    ) {
        self.snapshot = snapshot
        self.removedVaultSource = removedVaultSource
        self.syncable = syncable
        self.registry = registry
        self.opener = opener
        self.mint = mint
        self.secureStore = secureStore
        self.session = session
    }

    /// Every vault on the account, for Settings › Vaults.
    func accountVaults() async throws -> [VaultSummary] {
        try await readRegistry()
    }

    /// Whether a second vault exists to switch to. The switch is offered only
    /// when it would do something.
    private(set) var isSwitchable = false

    // MARK: - The list

    /// Reads the registry and decides the screen.
    ///
    /// One network call, awaited directly rather than queued: it suspends, and
    /// it cannot be cancelled (spec-defect 108), so the screen shows what is
    /// happening and offers no button that would lie about stopping it.
    func load() async {
        loadGeneration += 1
        dismissRemovedVaultNotice()
        phase = .loading
        vault = nil
        filler = nil
        let summaries: [VaultSummary]
        do {
            summaries = try await readRegistry()
        } catch {
            let mapped = ErrorMapping.userFacing(error)
            Log.sync.error("the vault registry could not be read", .code(mapped.code))
            // Local first: the vault this device last opened is on disk, and
            // its sync waits for the network (#5524). Only a transport or
            // server fault says nothing about the account. A refusal (signed
            // out, revoked, too old, too many devices) keeps its own screen:
            // opening the vault over it would hide the action it asks for.
            if Self.localFirstCodes.contains(mapped.code), let last = snapshot.lastVaultSummary {
                await open(registry.named(last), source: "auto")
                if case .opened = phase { registryNotice = mapped }
                return
            }
            // **Not** `.empty`. The account may hold four.
            phase = mapped.code == Self.offlineCode ? .offline : .unreadable(mapped)
            return
        }
        registryNotice = nil

        isSwitchable = summaries.count > 1
        Log.sync.info("read the vault registry", .count(summaries.count))
        guard let first = summaries.first else {
            phase = .empty
            return
        }
        snapshot.prune(keeping: Set(summaries.map(\.id)))
        guard summaries.count > 1 else {
            await open(first, source: "auto")
            return
        }
        // The vault open when the app was last used opens again without
        // asking. "Switch vault" clears it, so the list still shows then.
        if let last = snapshot.lastVault,
           let summary = summaries.first(where: { $0.id == last }) {
            await open(summary, source: "auto")
            return
        }
        phase = .choosing(summaries)
    }

    private static let offlineCode: ErrorCode = "transport.offline"

    /// A registry failure that is the network or the server being away, not
    /// an answer about the account (`ErrorMapping`: offline, timeout, failed,
    /// 5xx and 408).
    private static let localFirstCodes: Set<ErrorCode> = [
        offlineCode, "transport.timeout", "transport.failed", "api.statusServerFault",
    ]

    /// A vault is open without the registry: one read, from the notice's
    /// Try again or a trigger in ``watchRegistryTriggers(_:)``. Once the
    /// account answers it reconciles the open vault with the list: pruned
    /// snapshot, refreshed name, notice gone, sync started for a vault that
    /// joined the account meanwhile. A vault the account no longer lists goes
    /// through ``load()`` with ``removedVault`` set. Its files stay on
    /// disk, so nothing written offline is deleted.
    func registryReachable() async {
        guard !isRecheckingRegistry, registryNotice != nil, case let .opened(open) = phase else { return }
        isRecheckingRegistry = true
        defer { isRecheckingRegistry = false }
        let generation = loadGeneration
        let summaries: [VaultSummary]
        do {
            summaries = try await readRegistry()
        } catch {
            guard generation == loadGeneration else { return }
            let mapped = ErrorMapping.userFacing(error)
            // A refusal is not the notice's to show over a working vault. A
            // revocation wipes through `RevocationWatch` regardless.
            guard Self.localFirstCodes.contains(mapped.code) else {
                Log.sync.error("a vault registry re-read was refused", .code(mapped.code))
                return
            }
            registryNotice = mapped
            Log.sync.info("the vault registry is still unreachable", .code(mapped.code))
            return
        }
        // A switch or a reload while the read was out decided the screen anew.
        guard generation == loadGeneration else { return }
        snapshot.prune(keeping: Set(summaries.map(\.id)))
        guard let row = summaries.first(where: { $0.id == open.id }) else {
            await load()
            let source = removedVaultSource
            removedVault = RemovedVaultExport(summary: open) { try source(open.id) }
            return
        }
        registryNotice = nil
        isSwitchable = summaries.count > 1
        if row != open {
            snapshot.vaultOpened(row)
            phase = .opened(row)
        }
        // The local vault opened with no filler and may have joined the
        // account during this read: the signed-in registry registers it.
        guard filler == nil, let mint, let vault, syncable(row.id) else { return }
        do {
            let minted = try await mint.filler(for: vault, named: VaultLabel(row).text)
            if generation == loadGeneration { filler = minted }
        } catch {
            Log.sync.error("a vault filler could not be made", .code(ErrorMapping.userFacing(error).code))
        }
    }

    /// Re-reads the registry while the notice is up, on the triggers that say
    /// the server may answer now: the foreground, a network path change, a
    /// sync pass that got through. Runs until its task is cancelled.
    func watchRegistryTriggers(_ center: NotificationCenter = .default) async {
        let triggers = [
            UIApplication.didBecomeActiveNotification,
            PathReachability.attachmentPathChanged,
            Notification.Name.vaultSyncPassSucceeded,
        ]
        await withDiscardingTaskGroup { group in
            for name in triggers {
                group.addTask {
                    for await _ in center.notifications(named: name) { await self.registryReachable() }
                }
            }
        }
    }

    /// Hides the notice. An export still copying stops; its partial copy goes,
    /// the vault's own files never do.
    func dismissRemovedVaultNotice() {
        removedVault?.cancel()
        removedVault = nil
    }

    /// `registry.vaults()`, one call at a time and in the order asked.
    private func readRegistry() async throws -> [VaultSummary] {
        let previous = registryReads
        let registry = registry
        let read = Task {
            await previous?.value
            return try await registry.vaults()
        }
        registryReads = Task { _ = await read.result }
        return try await read.value
    }

    // MARK: - The open

    /// Opens one vault through `VaultFiles.openingVault`, which is the whole
    /// security half of this task. See `VaultOpening.swift`.
    func open(_ summary: VaultSummary, source: StaticString = "select") async {
        loadGeneration += 1
        phase = .opening(summary)
        do {
            let opened = try await opener.open(summary.id)
            // T237. Minted here, before the screen says the vault is open, so
            // that a vault which cannot be **filled** is never presented as a
            // vault that can only be read. `sync(session:)` blocks and does no
            // I/O, so this costs one trip through the core queue.
            filler = syncable(summary.id) ? try await mint?.filler(for: opened, named: VaultLabel(summary).text) : nil
            // Before `vault` is published, so the shell built from it reads
            // this vault's saved tab and stacks.
            snapshot.vaultOpened(summary)
            vault = opened
            phase = .opened(summary)
            Log.storage.notice("a vault was opened")
            Telemetry.shared.track(.vaultOpened, surface: .vault, action: "opened", source: source, result: .success)
            SyncTelemetry.vaultOpened(syncs: filler != nil)
        } catch {
            let mapped = ErrorMapping.userFacing(error)
            Log.storage.error("a vault could not be opened", .code(mapped.code))
            vault = nil
            filler = nil
            phase = .failedToOpen(summary, mapped)
        }
    }

    /// Back to the list, from an opened vault or from a failed open.
    ///
    /// The previous handle is dropped, which closes its database. Nothing is
    /// lost by that: the outbox is per vault because the database is per vault
    /// (data-model §C.2), so rows queued for the vault being left stay in that
    /// vault's own file and cannot be misattributed to the next one. Phase 4
    /// writes nothing at all — the exported surface is the read slice — so
    /// there is no flush to wait for here, and inventing one would be a
    /// mechanism this build does not have.
    func chooseAgain() async {
        // Leaving a vault, or one that failed to open, forgets it; a retry
        // after an unreadable registry keeps it.
        switch phase {
        case .opened, .failedToOpen: snapshot.vaultClosed()
        default: break
        }
        vault = nil
        filler = nil
        registryNotice = nil
        await load()
    }
}
