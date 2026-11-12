import Foundation
import MemryCore

// The free path: a vault that lives on this device with no account behind it.
//
// **Persisted in `UserDefaults`, not the keychain.** The id names a directory
// and carries no key material; the keychain is cleared on every sign-out, and
// this vault must outlive one. The keys are additive: an install that never
// chose the free path has neither, and reads as "no local vault".
//
// **Attaching never merges.** Signing in registers this vault on the account
// as a vault of its own (`AuthSession.registerVault`), unless it is empty and
// the account already has vaults: then it is forgotten (#4158). Until the
// register succeeds the vault stays local: listed beside the account's vaults, opened with no sync,
// and kept through a sign-out.

/// The local vault's id and whether the account knows it.
struct LocalVaultStore: @unchecked Sendable {
    // `UserDefaults` is thread-safe; it is not marked `Sendable` in the SDK.
    private let defaults: UserDefaults
    private let deviceNoun: String

    init(defaults: UserDefaults = .standard, deviceNoun: String = ThisDevice.noun) {
        self.defaults = defaults
        self.deviceNoun = deviceNoun
    }

    /// What the vault is called on screen and on the account: the device that
    /// created it. A vault created before the name was stored was always named
    /// "iPhone", and keeps that name.
    var name: String { defaults.string(forKey: Key.name) ?? "iPhone" }

    /// The vault's id, once the user chose to start on this device.
    var id: String? { defaults.string(forKey: Key.id) }

    /// `true` once `registerVault` succeeded for this id.
    var isAttached: Bool { defaults.bool(forKey: Key.attached) }

    /// Whether this id is the local vault and the account does not hold it, so
    /// it must not sync and must survive a sign-out.
    func isUnattached(_ vaultId: String) -> Bool {
        vaultId == id && !isAttached
    }

    /// Mints the id the first time and returns the existing one after that, so
    /// a second tap never strands the first vault.
    @discardableResult
    func create() -> String {
        if let id { return id }
        let minted = UUID().uuidString.lowercased()
        defaults.set(minted, forKey: Key.id)
        defaults.set(deviceNoun, forKey: Key.name)
        defaults.set(false, forKey: Key.attached)
        Telemetry.shared.track(.vaultCreated, surface: .vault, action: "created", source: "create", result: .success)
        return minted
    }

    func markAttached() {
        defaults.set(true, forKey: Key.attached)
    }

    /// Forgets the vault. Only after its content went with an account
    /// sign-out, or when it is empty and the account has vaults of its own;
    /// an unattached vault with content is never forgotten.
    func forget() {
        defaults.removeObject(forKey: Key.id)
        defaults.removeObject(forKey: Key.attached)
        defaults.removeObject(forKey: Key.name)
        defaults.removeObject(forKey: LocalSeedingMint.seededKey)
    }

    var summary: VaultSummary? {
        id.map { VaultSummary(id: $0, name: name, encryptedName: nil, nameNonce: nil) }
    }

    private enum Key {
        static let id = "localVault.id"
        static let attached = "localVault.attached"
        static let name = "localVault.name"
    }
}

/// The registry for a signed-out phone: the one local vault.
struct LocalVaultRegistry: VaultRegistry {
    let store: LocalVaultStore

    func vaults() async throws -> [VaultSummary] {
        store.summary.map { [$0] } ?? []
    }
}

/// Opens a vault after making sure this device can sign writes.
///
/// The writers refuse to write without a device identity, and a phone that
/// never signed in has none. `ensureDeviceIdentity` keeps an existing key, so
/// calling it on every open is safe, and signing in later commits the same key.
struct IdentityEnsuringOpener: VaultOpening {
    let inner: any VaultOpening
    let secureStore: any SecureStore
    let executor: CoreExecutor

    func open(_ vaultId: String) async throws -> Vault {
        let store = secureStore
        try await executor.run { try ensureDeviceIdentity(store: store) }
        return try await inner.open(vaultId)
    }
}

/// What attaching the local vault to the signed-in account did.
enum LocalVaultAttachOutcome: Equatable, Sendable {
    /// Nothing to attach: no local vault, or it is already on the account.
    case none
    case attached
    /// Empty, and the account already has vaults: forgotten, never added.
    case dropped
    /// No plan or no free vault slot. The vault stays local and nothing is lost.
    case needsPlan
    /// Anything else. The vault stays local and the next registry read retries.
    case failed(UserFacingError)
}

/// Whether a local vault holds anything.
///
/// Every core write commits its outbox row with the change, account or not
/// (`Vault::seed_unsynced`), so an empty outbox is a vault nobody wrote to.
/// Opened through `VaultFiles` and not `CoreVaultOpener`, which would repoint
/// the open vault's attachment directory at this one.
struct LocalVaultContent: Sendable {
    let files: VaultFiles
    let session: AuthSession
    let executor: CoreExecutor

    func isEmpty(_ vaultId: String) async throws -> Bool {
        let session = session
        return try await files.openingVault(vaultId) { directory in
            let path = directory.path
            return try await executor.run {
                try Vault.open(vaultId: vaultId, directory: path).sync(session: session).pendingChanges() == 0
            }
        }
    }
}

/// Registers the local vault on the account, once.
struct LocalVaultAttach: Sendable {
    let session: any AuthSessionProtocol
    let store: LocalVaultStore
    /// Whether the vault with this id holds nothing. Production passes
    /// `LocalVaultContent.isEmpty`.
    let isEmpty: @Sendable (String) async throws -> Bool

    /// - Parameter accountVaults: the account's vaults, read before attaching.
    func run(accountVaults: [VaultSummary]) async -> LocalVaultAttachOutcome {
        guard let id = store.id, !store.isAttached else { return .none }
        // An empty vault beside the account's own would only add a blank vault
        // to every device (#4158). It is forgotten, and the list offers the
        // account's vaults instead.
        if accountVaults.contains(where: { $0.id != id }) {
            do {
                if try await isEmpty(id) {
                    store.forget()
                    Log.sync.notice("the empty local vault was dropped: the account already has vaults")
                    return .dropped
                }
            } catch {
                let mapped = ErrorMapping.userFacing(error)
                Log.sync.error("could not tell whether the local vault is empty", .code(mapped.code))
                return .failed(mapped)
            }
        }
        do {
            try await session.registerVault(vaultId: id, name: store.name)
            store.markAttached()
            Log.sync.notice("the local vault was added to the account")
            return .attached
        } catch {
            if Self.isPaymentRequired(error) {
                Log.sync.notice("the local vault stays local: the account has no sync plan")
                return .needsPlan
            }
            let mapped = ErrorMapping.userFacing(error)
            Log.sync.error("the local vault could not be added to the account", .code(mapped.code))
            return .failed(mapped)
        }
    }

    static func isPaymentRequired(_ error: any Error) -> Bool {
        if case .PaymentRequired = error as? ApiError { return true }
        if case let .Api(source) = error as? AuthError, case .PaymentRequired = source { return true }
        return false
    }
}

/// The signed-in registry: lists the account's vaults, tries to attach the
/// local vault against them, then returns the account's vaults with the local one beside them while it is still local.
///
/// An account with no vaults gets a local vault, as desktop's own vault joins
/// an empty account: the phone always has a vault to write in, and the attach
/// registers it (or keeps it local without a plan).
struct AttachingVaultRegistry: VaultRegistry {
    let inner: any VaultRegistry
    let attach: LocalVaultAttach

    func vaults() async throws -> [VaultSummary] {
        var rows = try await inner.vaults()
        if rows.isEmpty { attach.store.create() }
        _ = await attach.run(accountVaults: rows)
        if let local = attach.store.summary, !rows.contains(where: { $0.id == local.id }) {
            rows.append(local)
        }
        return rows
    }
}

/// The sync mint for an account, which hands the attached local vault's
/// existing content to the outbox before its first pass.
///
/// `seedUnsynced` is a no-op when everything is already queued, which is the
/// normal case; it is called once so content written before an older build
/// queued it is not left behind.
struct LocalSeedingMint: VaultFillerMinting {
    let inner: any VaultFillerMinting
    let store: LocalVaultStore
    let executor: CoreExecutor
    static let seededKey = "localVault.seeded"

    func filler(for vault: Vault) async throws -> any VaultFilling {
        if vault.id() == store.id, store.isAttached, !UserDefaults.standard.bool(forKey: Self.seededKey) {
            let seeded = try await executor.run { try vault.seedUnsynced() }
            UserDefaults.standard.set(true, forKey: Self.seededKey)
            Log.sync.info("queued the local vault for its first push", .count(Int(seeded)))
        }
        return try await inner.filler(for: vault)
    }
}

/// Which screen a phone with no registered session shows.
enum EntryRoute: Equatable {
    case welcome
    case choice
    /// The sign-in flow; `canGoBack` when there is a screen behind it.
    case signIn(canGoBack: Bool)
    case local(String)

    /// - Parameters:
    ///   - wantsSignIn: the user asked to sign in from the choice screen, the
    ///     welcome link, or the local vault's Settings.
    static func decide(
        state: AuthState,
        welcomeSeen: Bool,
        wantsSignIn: Bool,
        localVaultId: String?
    ) -> EntryRoute {
        guard state == .signedOut else { return .signIn(canGoBack: false) }
        if wantsSignIn { return .signIn(canGoBack: true) }
        if let localVaultId { return .local(localVaultId) }
        return welcomeSeen ? .choice : .welcome
    }
}
