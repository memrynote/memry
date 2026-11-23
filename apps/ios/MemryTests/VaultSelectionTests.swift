import Foundation
import MemryCore
import Synchronization
import Testing

@testable import Memry

// T155. The picker, and the one rule that has teeth here: **an empty vault list
// and a list that could not be read are different screens.** The reader behind
// `GET /sync/vaults` once used a `filter_map` and told an account holding four
// vaults that it had none. This file asserts the two facts separately, in both
// directions, so an implementation that collapsed one into the other fails
// twice rather than passing quietly.

/// A scripted registry. It answers exactly what a test wrote down, and an
/// unscripted call is a loud failure rather than an empty list.
private struct ScriptedRegistry: VaultRegistry {
    let answer: Result<[VaultSummary], any Error>

    func vaults() async throws -> [VaultSummary] { try answer.get() }
}

private struct RegistryUnreachable: Error {}

/// A working opener: it succeeds, records the id, and hands back a `Vault` that
/// is not connected to anything.
///
/// `Vault(noHandle:)` is the generated escape hatch for exactly this — a value
/// of the right type with no Rust object behind it. Nothing here calls a method
/// on it, and nothing may: the handle is zero and the FFI would crash. The
/// **real** opener, with the real `VaultFiles` and the real core, is driven in
/// `VaultOpeningTests`, which is where the security obligation lives.
private final class ScriptedOpener: VaultOpening, @unchecked Sendable {
    private let failure: (any Error)?
    private let opened = Mutex<[String]>([])

    init(failing: (any Error)? = nil) {
        failure = failing
    }

    var openedVaultIds: [String] { opened.withLock { $0 } }

    func open(_ vaultId: String) async throws -> Vault {
        opened.withLock { $0.append(vaultId) }
        if let failure { throw failure }
        return Vault(noHandle: Vault.NoHandle())
    }
}

/// A launch snapshot of its own. `LaunchSnapshot.shared` is one value for the
/// whole process, and these tests run in parallel with each other and with
/// every other suite that opens a vault: a vault one of them remembered made
/// another's `load()` reopen it instead of offering the choice (#2834).
private func isolatedSnapshot() -> LaunchSnapshot {
    LaunchSnapshot(defaults: UserDefaults(suiteName: "vault-selection-\(UUID().uuidString)")!)
}

private func summary(_ id: String, _ name: String?) -> VaultSummary {
    VaultSummary(id: id, name: name)
}

@MainActor
@Suite("T155 vault selection")
struct VaultSelectionTests {
    private func model(
        _ answer: Result<[VaultSummary], any Error>,
        opener: ScriptedOpener = ScriptedOpener(),
        snapshot: LaunchSnapshot = isolatedSnapshot()
    ) -> VaultSelectionViewModel {
        VaultSelectionViewModel(
            registry: ScriptedRegistry(answer: answer),
            opener: opener,
            snapshot: snapshot
        )
    }

    @Test("an account with no vaults is empty, and is never reported as a failure")
    func anEmptyAccountIsEmpty() async {
        let opener = ScriptedOpener()
        let selection = model(.success([]), opener: opener)
        await selection.load()
        #expect(selection.phase == .empty)
        #expect(selection.vault == nil)
        #expect(selection.isSwitchable == false)
        // Nothing was opened, because there was nothing to open.
        #expect(opener.openedVaultIds.isEmpty)
    }

    @Test("a registry that could not be read is a failure, and is never reported as empty")
    func anUnreadableRegistryIsNotEmpty() async {
        let selection = model(.failure(RegistryUnreachable()))
        await selection.load()
        guard case let .unreadable(error) = selection.phase else {
            Issue.record("an unreadable registry rendered as \(selection.phase)")
            return
        }
        // `DESIGN.md`: an unrecognised error is loud, never blank.
        #expect(!error.title.isEmpty)
        #expect(error.isUserVisible)
        #expect(selection.phase != .empty)
    }

    @Test("a core refusal keeps its own sentence rather than becoming a generic one")
    func aCoreRefusalKeepsItsMapping() async {
        let selection = model(.failure(ApiError.Unauthorized(code: "AUTH_EXPIRED", message: "expired")))
        await selection.load()
        guard case let .unreadable(error) = selection.phase else {
            Issue.record("a refused registry read rendered as \(selection.phase)")
            return
        }
        #expect(error.code != ErrorMapping.unrecognised.code)
    }

    /// data-model §C.2 draws `VaultChoice` as "account holds **more than one**
    /// vault and none is chosen". One vault is not a choice.
    @Test("one vault is opened without asking")
    func oneVaultIsOpenedWithoutAsking() async {
        let opener = ScriptedOpener()
        let selection = model(.success([summary("only", "Personal")]), opener: opener)
        await selection.load()
        #expect(selection.phase == .opened(summary("only", "Personal")))
        #expect(selection.vault != nil)
        #expect(opener.openedVaultIds == ["only"])
        // There is nothing to switch to, so no switch is offered.
        #expect(selection.isSwitchable == false)
    }

    @Test("more than one vault is a choice, and nothing is opened until one is made")
    func moreThanOneVaultIsAChoice() async {
        let opener = ScriptedOpener()
        let vaults = [summary("a", "Work"), summary("b", "Personal")]
        let selection = model(.success(vaults), opener: opener)
        await selection.load()
        #expect(selection.phase == .choosing(vaults))
        #expect(selection.vault == nil)
        #expect(opener.openedVaultIds.isEmpty)
        #expect(selection.isSwitchable)

        await selection.open(vaults[1])
        #expect(opener.openedVaultIds == ["b"])
        #expect(selection.phase == .opened(vaults[1]))
        #expect(selection.vault != nil)
    }

    @Test("a vault that will not open says so, and leaves no handle behind")
    func aFailedOpenLeavesNoHandle() async {
        let refusal = StorageError.Migration(version: 21, what: "a migration refused")
        let opener = ScriptedOpener(failing: refusal)
        let selection = model(.success([summary("only", "Personal")]), opener: opener)
        await selection.load()
        guard case let .failedToOpen(which, error) = selection.phase else {
            Issue.record("a failed open rendered as \(selection.phase)")
            return
        }
        #expect(which.id == "only")
        #expect(error.code == ErrorMapping.userFacing(refusal).code)
        // A half-open vault must not be readable.
        #expect(selection.vault == nil)
    }

    /// Switching re-reads the registry and drops the previous handle, which is
    /// what closes that vault's database — and therefore what makes the next
    /// open a **second** open with new sidecars to sweep.
    @Test("switching vaults drops the open handle and asks again")
    func switchingDropsTheHandle() async {
        let opener = ScriptedOpener()
        let vaults = [summary("a", "Work"), summary("b", "Personal")]
        let selection = model(.success(vaults), opener: opener)
        await selection.load()
        await selection.open(vaults[0])
        #expect(selection.vault != nil)

        await selection.chooseAgain()
        #expect(selection.vault == nil)
        #expect(selection.phase == .choosing(vaults))
        #expect(opener.openedVaultIds == ["a"])
    }

    @Test("the vault open last time reopens without asking, and switching forgets it")
    func theLastVaultReopensUntilSwitched() async {
        let snapshot = isolatedSnapshot()
        snapshot.vaultOpened("b")
        let opener = ScriptedOpener()
        let vaults = [summary("a", "Work"), summary("b", "Personal")]
        let selection = model(.success(vaults), opener: opener, snapshot: snapshot)
        await selection.load()
        #expect(selection.phase == .opened(vaults[1]))
        #expect(opener.openedVaultIds == ["b"])

        await selection.chooseAgain()
        #expect(snapshot.lastVault == nil)
        #expect(selection.phase == .choosing(vaults))
        #expect(opener.openedVaultIds == ["b"])
    }
}

/// A registry that answers what it is told, and can be told again: the
/// network coming back between two reads.
private final class SwitchableRegistry: VaultRegistry, @unchecked Sendable {
    private let answer: Mutex<Result<[VaultSummary], any Error>>

    init(_ answer: Result<[VaultSummary], any Error>) {
        self.answer = Mutex(answer)
    }

    func answer(_ next: Result<[VaultSummary], any Error>) {
        answer.withLock { $0 = next }
    }

    func vaults() async throws -> [VaultSummary] { try answer.withLock { $0 }.get() }

    /// Stands in for `CoreVaultRegistry` opening a sealed name with the
    /// master key.
    func named(_ row: VaultSummary) -> VaultSummary {
        var named = row
        if row.encryptedName == "sealed-personal" { named.name = "Personal" }
        return named
    }
}

private let offline = ApiError.Transport(source: .Offline)

/// #5524. A relaunch with no network opens the vault this device already holds.
@MainActor
@Suite("#5524 offline launch")
struct OfflineLaunchTests {
    private let personal = VaultSummary(
        id: "b", name: "Personal", encryptedName: "sealed-personal", nameNonce: "nonce"
    )

    @Test("an offline relaunch opens the last vault, named, with a notice over it")
    func offlineRelaunchOpensTheLastVault() async throws {
        let suite = "offline-launch-\(UUID().uuidString)"
        let registry = SwitchableRegistry(.success([summary("a", "Work"), personal]))
        let first = VaultSelectionViewModel(
            registry: registry,
            opener: ScriptedOpener(),
            snapshot: LaunchSnapshot(defaults: try #require(UserDefaults(suiteName: suite)))
        )
        await first.load()
        await first.open(personal)

        // The relaunch: a fresh snapshot over the same defaults, no network.
        registry.answer(.failure(offline))
        let opener = ScriptedOpener()
        let relaunch = VaultSelectionViewModel(
            registry: registry,
            opener: opener,
            snapshot: LaunchSnapshot(defaults: try #require(UserDefaults(suiteName: suite)))
        )
        await relaunch.load()

        #expect(opener.openedVaultIds == ["b"])
        #expect(relaunch.vault != nil)
        guard case let .opened(opened) = relaunch.phase else {
            Issue.record("an offline relaunch rendered as \(relaunch.phase)")
            return
        }
        #expect(opened.id == "b")
        #expect(VaultLabel(opened) == .named("Personal"))
        #expect(relaunch.registryNotice?.code == ErrorMapping.userFacing(offline).code)
        #expect(relaunch.registryNotice?.recourse == .retryLater)

        // The network comes back: the notice goes, the vault stays.
        registry.answer(.success([summary("a", "Work"), personal]))
        await relaunch.registryReachable()
        #expect(relaunch.registryNotice == nil)
        #expect(relaunch.phase == .opened(opened))
        #expect(relaunch.isSwitchable)
    }

    @Test("the snapshot keeps the sealed name, never the opened one")
    func theSnapshotHoldsNoPlaintextName() throws {
        let suite = "offline-launch-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        LaunchSnapshot(defaults: defaults).vaultOpened(personal)
        let stored = try #require(defaults.data(forKey: "launchSnapshot.v1"))
        #expect(String(decoding: stored, as: UTF8.self).contains("Personal") == false)
        let reread = LaunchSnapshot(defaults: defaults).lastVaultSummary
        #expect(reread?.encryptedName == "sealed-personal")
        #expect(reread?.name == nil)
    }

    @Test("offline with no vault on this device asks for a connection, and opens nothing")
    func offlineWithNoVaultAsksForAConnection() async {
        let opener = ScriptedOpener()
        let selection = VaultSelectionViewModel(
            registry: SwitchableRegistry(.failure(offline)),
            opener: opener,
            snapshot: isolatedSnapshot()
        )
        await selection.load()
        #expect(selection.phase == .offline)
        #expect(selection.vault == nil)
        #expect(selection.registryNotice == nil)
        #expect(opener.openedVaultIds.isEmpty)
    }
}

@Suite("T155 vault names")
struct VaultLabelTests {
    @Test("a named vault is rendered by its name")
    func aNamedVaultKeepsItsName() {
        let label = VaultLabel(summary("a", "Work"))
        #expect(label == .named("Work"))
        #expect(label.text == "Work")
        #expect(label.isPlaceholder == false)
    }

    /// `VaultSummary.name` is `Optional` on purpose: absent means the registry
    /// row carries no name, which is a different fact from a row whose name is
    /// empty. Coalescing either to `""` renders a blank row and loses both.
    @Test("a vault with no name and a vault with an empty name are told apart")
    func absentIsNotEmpty() {
        let absent = VaultLabel(summary("a", nil))
        let blank = VaultLabel(summary("b", ""))
        #expect(absent == .unnamed)
        #expect(blank == .blankName)
        #expect(absent != blank)
        #expect(absent.text != blank.text)
        // Neither renders as nothing.
        #expect(!absent.text.isEmpty)
        #expect(!blank.text.isEmpty)
        #expect(absent.isPlaceholder)
        #expect(blank.isPlaceholder)
    }

    /// A vault id identifies content. It is never logged (`Log` has nowhere to
    /// put one) and it is not shown either.
    @Test("the vault id is never the label")
    func theIdIsNotTheLabel() {
        for label in [VaultLabel(summary("vault-0123", nil)), VaultLabel(summary("vault-0123", ""))] {
            #expect(!label.text.contains("vault-0123"))
        }
    }
}
