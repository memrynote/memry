import Foundation
import MemryCore
import Observation

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

/// What one registry row is called on screen.
///
/// Three cases, not two, because `VaultSummary.name` is `Optional` on purpose:
/// absent means the row carries no name at all, which is a different fact from
/// a row whose name is empty. Coalescing either to `""` renders a blank row and
/// loses the distinction the registry went to the trouble of keeping.
enum VaultLabel: Equatable, Sendable {
    case named(String)
    /// The registry row carries no name.
    case unnamed
    /// The registry row carries a name, and it is empty.
    case blankName

    init(_ summary: VaultSummary) {
        switch summary.name {
        case .none: self = .unnamed
        case let .some(name) where name.isEmpty: self = .blankName
        case let .some(name): self = .named(name)
        }
    }

    /// The row's title. Never empty, and never the vault id: an id identifies
    /// content and is noise to read, so a vault without a usable name says so
    /// in words instead.
    var text: String {
        switch self {
        case let .named(name): name
        case .unnamed: "Unnamed vault"
        case .blankName: "Vault with a blank name"
        }
    }

    /// Whether the title is the user's own words or this file's.
    var isPlaceholder: Bool {
        if case .named = self { return false }
        return true
    }
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
        case opening(VaultSummary)
        case opened(VaultSummary)
        case failedToOpen(VaultSummary, UserFacingError)
    }

    private(set) var phase: Phase = .loading

    /// The open handle, for the screens that read it (T156, T157).
    ///
    /// Dropping it closes the connection, which is why switching vaults
    /// re-enters ``open(_:)`` rather than reusing anything: the next open of
    /// the same vault creates fresh `-wal`/`-shm` files and must sweep them
    /// again. See `VaultOpening.swift`.
    private(set) var vault: Vault?

    private let registry: any VaultRegistry
    private let opener: any VaultOpening

    init(registry: any VaultRegistry, opener: any VaultOpening) {
        self.registry = registry
        self.opener = opener
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
        phase = .loading
        vault = nil
        let summaries: [VaultSummary]
        do {
            summaries = try await registry.vaults()
        } catch {
            let mapped = ErrorMapping.userFacing(error)
            Log.sync.error("the vault registry could not be read", .code(mapped.code))
            // **Not** `.empty`. The account may hold four.
            phase = .unreadable(mapped)
            return
        }

        isSwitchable = summaries.count > 1
        Log.sync.info("read the vault registry", .count(summaries.count))
        guard let first = summaries.first else {
            phase = .empty
            return
        }
        guard summaries.count > 1 else {
            await open(first)
            return
        }
        phase = .choosing(summaries)
    }

    // MARK: - The open

    /// Opens one vault through `VaultFiles.openingVault`, which is the whole
    /// security half of this task. See `VaultOpening.swift`.
    func open(_ summary: VaultSummary) async {
        phase = .opening(summary)
        do {
            let opened = try await opener.open(summary.id)
            vault = opened
            phase = .opened(summary)
            Log.storage.notice("a vault was opened")
        } catch {
            let mapped = ErrorMapping.userFacing(error)
            Log.storage.error("a vault could not be opened", .code(mapped.code))
            vault = nil
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
        vault = nil
        await load()
    }
}
