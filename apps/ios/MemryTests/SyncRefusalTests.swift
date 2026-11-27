import Foundation
import MemryCore
import Synchronization
import Testing

@testable import Memry

// #5373: a refused sync pass showed a generic "server refused that request"
// that stayed on screen after later passes succeeded, and nobody could tell
// which refusal it was.

/// Refuses the first pass the way the core reports the plan's vault cap, then
/// lets every later pass through.
private final class RefusedOnce: VaultFilling, @unchecked Sendable {
    private let passes = Mutex(0)

    func syncNow() async throws -> SyncPassSummary {
        let first = passes.withLock { count in
            count += 1
            return count == 1
        }
        if first {
            throw SyncError.Api(source: .PaymentRequired(
                code: "SYNC_VAULT_LIMIT_EXCEEDED",
                message: "plus allows 1 synced vaults"
            ))
        }
        return SyncPassSummary(pulled: 0, deleted: 0, bodies: 0, pushed: 0, rejected: 0, pending: 0)
    }

    func isFirstSyncComplete() async throws -> Bool { true }
    func firstSync(
        progress: @escaping @MainActor @Sendable (SyncProgress) -> Void
    ) async throws -> FirstSyncSummary {
        throw SyncError.Locked
    }
    func pullNoteBody(noteId: String) async throws -> BodyFetchSummary {
        throw SyncError.Locked
    }
}

@MainActor
@Suite("Sync refusals", .serialized)
struct SyncRefusalTests {
    @Test func a_vault_limit_shows_the_plan_copy_and_clears_after_a_good_pass() async throws {
        let vault = try TasksTestVault(filler: RefusedOnce())

        await vault.store.sync()
        let refused = try #require(vault.store.failure)
        #expect(refused.code == ErrorCode("api.vaultLimitReached"))
        #expect(refused.title == "Your plan has no room for another synced vault.")
        #expect(refused.guidance?.hasPrefix("This vault stays on this") == true)

        await vault.store.sync()
        #expect(vault.store.failure == nil)
    }

    @Test func a_calendar_sync_refusal_clears_after_a_good_pass() async throws {
        let tasks = try TasksTestVault()
        let calendar = CalendarStore(
            core: try tasks.vault.calendar(store: TaskTestKeychain()), vaultId: "vault-test",
            filler: RefusedOnce(), tasks: tasks.store
        )

        await calendar.sync(forceProviders: false)
        #expect(calendar.failure?.code == ErrorCode("api.vaultLimitReached"))

        await calendar.sync(forceProviders: false)
        #expect(calendar.failure == nil)
    }

    /// The production filler names the refusal after its vault, so the copy
    /// says which vault is not syncing.
    @Test func a_vault_limit_names_the_vault_that_is_not_syncing() {
        let refusal = SyncError.Api(source: .PaymentRequired(code: "SYNC_VAULT_LIMIT_EXCEEDED", message: "full"))
        let named = ErrorMapping.userFacing(VaultPlanFull.naming("Work", in: refusal))
        #expect(named.code == ErrorCode("api.vaultLimitReached"))
        #expect(named.title.hasPrefix("\u{201C}Work\u{201D} is not syncing"))
        #expect(named.title.contains("no room for another synced vault"))

        // Any other refusal passes through untouched.
        let noPlan = SyncError.Api(source: .PaymentRequired(code: "SYNC_PAYMENT_REQUIRED", message: "none"))
        #expect(VaultPlanFull.naming("Work", in: noPlan) as? SyncError == noPlan)
        #expect(VaultPlanFull.naming("Work", in: SyncError.Locked) as? SyncError == .Locked)
    }

    @Test func a_generic_refusal_carries_its_status_and_code() {
        let refused = ErrorMapping.userFacing(SyncError.Api(source: .Status(
            status: 400, code: "VALIDATION_ERROR", message: "X-Memry-Vault-Id is required"
        )))
        #expect(refused.code == ErrorCode("api.statusRefused"))
        #expect(refused.guidance?.hasSuffix("Server reply: 400 VALIDATION_ERROR.") == true)
        #expect(!refused.text.contains("X-Memry-Vault-Id"), "the server's message is a payload")

        let bare = ErrorMapping.userFacing(ApiError.Status(status: 404, code: nil, message: "gone"))
        #expect(bare.guidance?.hasSuffix("Server reply: 404.") == true)
    }

    @Test func the_account_notice_clears_on_reload_not_on_a_sync_pass() async {
        let session = FakeAuthSession(from: .registered)
        session.scriptBilling(BillingStatus(
            email: "a@b.c", plan: "plus", status: "active", cadence: nil,
            storageLimit: 0, storageUsed: 0, maxFileSize: 0, maxVaults: 1, versionHistoryDays: 0,
            expiresAt: nil, store: nil, manageUrl: nil, willRenew: nil, appAccountToken: nil,
            canManageBilling: nil
        ))
        let account = AccountModel(session: session, filler: nil)

        await account.load()
        await account.loadStorage()
        #expect(account.failure != nil, "the fake refuses storage")
        // A pass says nothing about the account calls, so their refusal stays.
        account.syncFinished(true)
        #expect(account.failure != nil)

        await account.load()
        #expect(account.failure == nil)
    }
}
