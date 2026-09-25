import Foundation
import MemryCore
import Observation

// Spec 006. Everything a Settings screen reads, gathered once per opened vault
// and handed down the Settings stack through the environment.

@MainActor
@Observable
final class SettingsContext {
    let store: SettingsStore
    let local: LocalSettings
    let tasks: TasksStore
    /// Tags, properties and templates live on the vault's `Tasks` core object.
    let content: any TasksProtocol
    let notes: Notes
    let account: AccountModel
    let vaults: VaultSelectionViewModel
    let vaultId: String
    let executor: CoreExecutor

    init(
        store: SettingsStore,
        local: LocalSettings = .shared,
        tasks: TasksStore,
        content: any TasksProtocol,
        notes: Notes,
        account: AccountModel,
        vaults: VaultSelectionViewModel,
        vaultId: String,
        executor: CoreExecutor = .shared
    ) {
        self.store = store
        self.local = local
        self.tasks = tasks
        self.content = content
        self.notes = notes
        self.account = account
        self.vaults = vaults
        self.vaultId = vaultId
        self.executor = executor
    }

    /// Runs one blocking call on the content core. Errors come back mapped.
    func run<T: Sendable>(_ work: @escaping @Sendable (any TasksProtocol) throws -> T) async -> Result<T, UserFacingError> {
        let content = content
        do {
            let value = try await executor.run { try work(content) }
            tasks.scheduleSync()
            return .success(value)
        } catch {
            let mapped = ErrorMapping.userFacing(error)
            Log.core.error("a settings content call failed", .code(mapped.code))
            return .failure(mapped)
        }
    }

    func read<T: Sendable>(_ work: @escaping @Sendable (any TasksProtocol) throws -> T) async -> Result<T, UserFacingError> {
        let content = content
        do {
            return .success(try await executor.run { try work(content) })
        } catch {
            return .failure(ErrorMapping.userFacing(error))
        }
    }
}

/// So a Settings call can hand back `Result<T, UserFacingError>`: the error a
/// screen shows is already the mapped one.
extension UserFacingError: Error {}

/// The account half: plan, storage, devices and sync state.
@MainActor
@Observable
final class AccountModel {
    private let session: (any AuthSessionProtocol)?
    private let filler: (any VaultFilling)?
    private let local: LocalSettings

    private(set) var billing: BillingStatus?
    private(set) var storage: StorageUsage?
    private(set) var devices: [AccountDevice] = []
    private(set) var pending: UInt32 = 0
    private(set) var failure: UserFacingError?
    private(set) var isOffline = false

    init(session: (any AuthSessionProtocol)?, filler: (any VaultFilling)?, local: LocalSettings = .shared) {
        self.session = session
        self.filler = filler
        self.local = local
    }

    var email: String? { billing?.email }
    var hasSession: Bool { session != nil }
    var thisDevice: AccountDevice? { devices.first { $0.isCurrent } }
    var otherDevices: [AccountDevice] {
        // Last seen first; a device that never synced ranks by when it was
        // added, so one linked a moment ago is at the top ("Linked just now").
        devices.filter { !$0.isCurrent }.sorted { Self.seconds($0) > Self.seconds($1) }
    }

    /// Epoch seconds of last activity; the server's timestamps may be s or ms.
    static func seconds(_ device: AccountDevice) -> Int64 {
        let value = device.lastSyncAt ?? device.createdAt ?? 0
        return value > 10_000_000_000 ? value / 1000 : value
    }

    func load() async {
        await refreshPending()
        guard let session else { return }
        do {
            billing = try await session.billing()
            isOffline = false
        } catch {
            record(error)
        }
    }

    func loadStorage() async {
        guard let session else { return }
        do { storage = try await session.storage() } catch { record(error) }
    }

    func loadDevices() async {
        guard let session else { return }
        do { devices = try await session.devices() } catch { record(error) }
    }

    func refreshPending() async {
        pending = (try? await filler?.pendingChanges()) ?? 0
    }

    /// A pass ended: `true` when it reached the server.
    func syncFinished(_ succeeded: Bool) {
        if succeeded {
            local.lastSyncedAt = .now
            isOffline = false
        } else {
            isOffline = true
        }
        Task { await refreshPending() }
    }

    /// - Returns: `nil` on success, otherwise the mapped refusal.
    func rename(_ device: AccountDevice, to name: String) async -> UserFacingError? {
        guard let session else { return nil }
        do {
            try await session.renameDevice(id: device.id, name: name)
            await loadDevices()
            return nil
        } catch {
            return mapped(error)
        }
    }

    func revoke(_ device: AccountDevice) async -> UserFacingError? {
        guard let session, !device.isCurrent else { return nil }
        do {
            try await session.revokeDevice(id: device.id)
            devices.removeAll { $0.id == device.id }
            return nil
        } catch {
            return mapped(error)
        }
    }

    func deleteVault(_ id: String) async -> UserFacingError? {
        guard let session else { return nil }
        do {
            try await session.deleteVault(vaultId: id)
            return nil
        } catch {
            return mapped(error)
        }
    }

    func approver() -> DeviceApprover? { session?.deviceApprover() }

    func clearFailure() { failure = nil }

    private func record(_ error: any Error) {
        let mapped = mapped(error)
        if case .Api(.Transport) = error as? AuthError { isOffline = true }
        if case .Transport = error as? ApiError { isOffline = true }
        failure = mapped.isUserVisible ? mapped : nil
    }

    private func mapped(_ error: any Error) -> UserFacingError {
        let mapped = ErrorMapping.userFacing(error)
        Log.auth.error("an account settings call failed", .code(mapped.code))
        return mapped
    }
}
