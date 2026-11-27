import Foundation
import MemryCore
import Synchronization
import Testing
import UIKit

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
        snapshot.vaultOpened(VaultSummary(id: "b", name: nil))
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

    private func relaunch(
        _ registry: any VaultRegistry,
        snapshot: LaunchSnapshot = isolatedSnapshot(),
        opener: ScriptedOpener = ScriptedOpener()
    ) -> VaultSelectionViewModel {
        snapshot.vaultOpened(personal)
        return VaultSelectionViewModel(registry: registry, opener: opener, snapshot: snapshot)
    }

    @Test("only a network or server fault opens the vault; a refusal keeps its own screen")
    func onlyTransportAndServerFaultsFallBack() async {
        let faults: [any Error] = [
            offline,
            ApiError.Transport(source: .Timeout(elapsedMs: 30_000)),
            ApiError.Transport(source: .Failed(what: "x")),
            ApiError.Status(status: 503, code: nil, message: "x"),
            ApiError.Status(status: 408, code: nil, message: "x"),
        ]
        for fault in faults {
            let opener = ScriptedOpener()
            let selection = relaunch(SwitchableRegistry(.failure(fault)), opener: opener)
            await selection.load()
            #expect(opener.openedVaultIds == ["b"], "\(ErrorMapping.userFacing(fault).code)")
            #expect(selection.registryNotice != nil)
        }
        let refusals: [any Error] = [
            ApiError.Unauthorized(code: "x", message: "x"),
            ApiError.DeviceRevoked(message: "x"),
            ApiError.DeviceLimitReached(message: "x"),
            ApiError.UpgradeRequired(minVersion: "9", message: "x"),
            ApiError.Transport(source: .Tls(what: "x")),
        ]
        for refusal in refusals {
            let opener = ScriptedOpener()
            let selection = relaunch(SwitchableRegistry(.failure(refusal)), opener: opener)
            await selection.load()
            let code = ErrorMapping.userFacing(refusal).code
            #expect(selection.phase == .unreadable(ErrorMapping.userFacing(refusal)), "\(code)")
            #expect(opener.openedVaultIds.isEmpty, "\(code)")
            #expect(selection.vault == nil)
        }
    }

    @Test("Try again while the server is still away keeps the vault and updates the notice")
    func retryWhileStillAway() async {
        let registry = SwitchableRegistry(.failure(offline))
        let selection = relaunch(registry)
        await selection.load()
        registry.answer(.failure(ApiError.Status(status: 503, code: nil, message: "x")))
        await selection.registryReachable()
        #expect(selection.registryNotice?.code == "api.statusServerFault")
        #expect(selection.phase == .opened(VaultSummary(
            id: "b", name: "Personal", encryptedName: "sealed-personal", nameNonce: "nonce"
        )))
        registry.answer(.success([personal]))
        await selection.registryReachable()
        #expect(selection.registryNotice == nil)
    }

    @Test("reconnecting prunes the snapshot and refreshes the vault's name")
    func reconnectReconciles() async {
        let snapshot = isolatedSnapshot()
        snapshot.vaultOpened(VaultSummary(id: "gone", name: nil))
        snapshot.setStack("k", Data([1]))
        let registry = SwitchableRegistry(.failure(offline))
        let selection = relaunch(registry, snapshot: snapshot)
        await selection.load()

        let renamed = VaultSummary(id: "b", name: "Renamed", encryptedName: "sealed-2", nameNonce: "n2")
        registry.answer(.success([summary("a", "Work"), renamed]))
        await selection.registryReachable()

        #expect(selection.phase == .opened(renamed))
        #expect(snapshot.lastVaultSummary?.encryptedName == "sealed-2")
        snapshot.vaultOpened(VaultSummary(id: "gone", name: nil))
        #expect(snapshot.stack("k") == nil)
    }

    @Test("reconnecting to an account that no longer lists the open vault shows the list flow")
    func reconnectAfterTheVaultWasRemoved() async {
        let registry = SwitchableRegistry(.failure(offline))
        let opener = ScriptedOpener()
        let selection = relaunch(registry, opener: opener)
        await selection.load()

        registry.answer(.success([summary("a", "Work")]))
        await selection.registryReachable()

        #expect(selection.phase == .opened(summary("a", "Work")))
        #expect(selection.registryNotice == nil)
        #expect(opener.openedVaultIds == ["b", "a"])
        #expect(selection.removedVault?.summary.id == "b")

        selection.dismissRemovedVaultNotice()
        #expect(selection.removedVault == nil)
    }

    @Test("a refusal during a re-read keeps the vault and the offline notice")
    func aRefusalDuringAReRead() async {
        let registry = SwitchableRegistry(.failure(offline))
        let selection = relaunch(registry)
        await selection.load()
        let notice = selection.registryNotice
        for refusal: any Error in [
            ApiError.Unauthorized(code: "x", message: "x"),
            ApiError.UpgradeRequired(minVersion: "9", message: "x"),
            ApiError.Transport(source: .Tls(what: "x")),
        ] {
            registry.answer(.failure(refusal))
            await selection.registryReachable()
            #expect(selection.registryNotice == notice, "\(ErrorMapping.userFacing(refusal).code)")
            #expect(selection.vault != nil)
        }
    }

    @Test("a vault that joins the account during the re-read starts syncing")
    func aVaultThatAttachesGetsAFiller() async {
        let attached = Mutex(false)
        let mint = CountingMint()
        let snapshot = isolatedSnapshot()
        snapshot.vaultOpened(personal)
        let registry = SwitchableRegistry(.failure(offline))
        let selection = VaultSelectionViewModel(
            registry: registry, opener: ScriptedOpener(), mint: mint, snapshot: snapshot,
            syncable: { _ in attached.withLock { $0 } }
        )
        await selection.load()
        #expect(selection.filler == nil)

        attached.withLock { $0 = true }
        registry.answer(.success([personal]))
        await selection.registryReachable()
        #expect(selection.filler != nil)
        #expect(mint.minted.withLock { $0 } == 1)
    }

    @Test("a trigger while a re-read is out waits for it instead of reading again")
    func reReadsCoalesce() async {
        let registry = GatedRegistry()
        let selection = relaunch(registry)
        let launch = Task { await selection.load() }
        await registry.nextCall()
        registry.release(.failure(offline))
        await launch.value

        let first = Task { await selection.registryReachable() }
        await registry.nextCall()
        #expect(selection.isRecheckingRegistry)
        await selection.registryReachable()
        #expect(registry.pending == 1)
        registry.release(.success([personal]))
        await first.value
        #expect(!selection.isRecheckingRegistry)
        #expect(selection.registryNotice == nil)
    }

    @Test(
        "the foreground and a sync pass that got through re-read the registry",
        .timeLimit(.minutes(1)),
        arguments: [UIApplication.didBecomeActiveNotification, Notification.Name.vaultSyncPassSucceeded]
    )
    func triggersReRead(_ trigger: Notification.Name) async throws {
        let registry = GatedRegistry()
        let selection = relaunch(registry)
        let launch = Task { await selection.load() }
        await registry.nextCall()
        registry.release(.failure(offline))
        await launch.value

        let center = NotificationCenter()
        let watch = Task { await selection.watchRegistryTriggers(center) }
        // The watch subscribes on its own task; post until it hears one.
        while registry.pending == 0 {
            center.post(name: trigger, object: nil)
            try await Task.sleep(for: .milliseconds(10))
        }
        registry.release(.success([personal]))
        while selection.registryNotice != nil { await Task.yield() }
        watch.cancel()
        await watch.value
        #expect(selection.phase == .opened(personal))
    }

    /// The ABA: a read started for one screen must not touch the screen a
    /// reload put in its place, even one that looks the same afterwards.
    @Test("a stale read does not clear the notice of a screen that replaced it")
    func aStaleReadIsDropped() async {
        let registry = GatedRegistry()
        let opener = ScriptedOpener()
        let selection = relaunch(registry, opener: opener)
        let launch = Task { await selection.load() }
        await registry.nextCall()
        registry.release(.failure(offline))
        await launch.value
        #expect(selection.registryNotice != nil)

        let stale = Task { await selection.registryReachable() }
        await registry.nextCall()
        let reload = Task { await selection.load() }
        registry.release(.success([personal]))
        await stale.value

        #expect(selection.phase == .loading)
        #expect(selection.registryNotice != nil)

        await registry.nextCall()
        registry.release(.failure(offline))
        await reload.value
        #expect(selection.registryNotice != nil)
        #expect(opener.openedVaultIds == ["b", "b"])
    }
}

/// A registry whose reads wait to be answered, one at a time in the order
/// they started, so a test decides which read ends when.
private final class GatedRegistry: VaultRegistry, @unchecked Sendable {
    private let waiting = Mutex<[CheckedContinuation<Result<[VaultSummary], any Error>, Never>]>([])
    private let arrivals: AsyncStream<Void>
    private let arrive: AsyncStream<Void>.Continuation
    private var arrivalIterator: AsyncStream<Void>.AsyncIterator

    init() {
        (arrivals, arrive) = AsyncStream.makeStream(of: Void.self)
        arrivalIterator = arrivals.makeAsyncIterator()
    }

    func vaults() async throws -> [VaultSummary] {
        let answer = await withCheckedContinuation { continuation in
            waiting.withLock { $0.append(continuation) }
            arrive.yield()
        }
        return try answer.get()
    }

    var pending: Int { waiting.withLock { $0.count } }

    /// Returns once a read is waiting.
    func nextCall() async { _ = await arrivalIterator.next() }

    func release(_ answer: Result<[VaultSummary], any Error>) {
        waiting.withLock { $0.removeFirst() }.resume(returning: answer)
    }
}

private final class CountingMint: VaultFillerMinting, @unchecked Sendable {
    let minted = Mutex(0)

    func filler(for vault: Vault, named name: String) async throws -> any VaultFilling {
        minted.withLock { $0 += 1 }
        return IdleFiller()
    }
}

private final class IdleFiller: VaultFilling, @unchecked Sendable {
    func isFirstSyncComplete() async throws -> Bool { true }
    func firstSync(
        progress: @escaping @MainActor @Sendable (SyncProgress) -> Void
    ) async throws -> FirstSyncSummary { .none }
    func pullNoteBody(noteId: String) async throws -> BodyFetchSummary {
        BodyFetchSummary(updates: 0, baselines: 0, stopped: false)
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
