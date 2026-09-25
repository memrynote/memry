import MemryCore
@testable import Memry

// Spec 006 widened `AuthSessionProtocol` with the Settings account calls.
// The scripted sessions in this target predate them and never exercise them,
// so they get refusing defaults here instead of one stub per fake.

struct UnscriptedSettingsCall: Error {}

extension AuthSessionProtocol {
    func devices() async throws -> [AccountDevice] { throw UnscriptedSettingsCall() }
    func renameDevice(id _: String, name _: String) async throws { throw UnscriptedSettingsCall() }
    func revokeDevice(id _: String) async throws { throw UnscriptedSettingsCall() }
    func storage() async throws -> StorageUsage { throw UnscriptedSettingsCall() }
    func billing() async throws -> BillingStatus { throw UnscriptedSettingsCall() }
    func deleteVault(vaultId _: String) async throws { throw UnscriptedSettingsCall() }
    func deviceApprover() -> DeviceApprover {
        fatalError("deviceApprover is not scripted in this fake")
    }
}
