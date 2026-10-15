import Foundation
import MemryCore
import Testing

@testable import Memry

// The free path: which screen a phone with no session shows, the local
// vault's persistence, attaching it after sign-in, and the billing mapping.

private func isolatedStore() -> LocalVaultStore {
    LocalVaultStore(defaults: UserDefaults(suiteName: "local-vault-\(UUID().uuidString)")!)
}

private struct ListedVaults: VaultRegistry {
    let rows: [VaultSummary]
    func vaults() async throws -> [VaultSummary] { rows }
}

private func status(plan: String, status: String, store: String? = nil) -> BillingStatus {
    BillingStatus(
        email: "a@b.c", plan: plan, status: status, cadence: "annual",
        storageLimit: 0, storageUsed: 0, maxFileSize: 0, maxVaults: 1, versionHistoryDays: 30,
        expiresAt: nil, store: store, manageUrl: nil, willRenew: nil, appAccountToken: nil,
        canManageBilling: nil
    )
}

@Suite("Free local vault")
struct FreeLocalVaultTests {
    // MARK: - Routing

    @Test("a signed-out phone with a local vault opens it")
    func localVaultOpensWithoutSession() {
        let route = EntryRoute.decide(state: .signedOut, welcomeSeen: true, wantsSignIn: false, localVaultId: "v1")
        #expect(route == .local("v1"))
    }

    @Test("first launch shows welcome; a seen welcome shows the choice")
    func welcomeThenChoice() {
        #expect(EntryRoute.decide(state: .signedOut, welcomeSeen: false, wantsSignIn: false, localVaultId: nil) == .welcome)
        #expect(EntryRoute.decide(state: .signedOut, welcomeSeen: true, wantsSignIn: false, localVaultId: nil) == .choice)
    }

    @Test("asking to sign in wins over the local vault, with a way back")
    func signInFromLocal() {
        let route = EntryRoute.decide(state: .signedOut, welcomeSeen: true, wantsSignIn: true, localVaultId: "v1")
        #expect(route == .signIn(canGoBack: true))
    }

    @Test("a sign-in in progress has no back")
    func signInInProgress() {
        let route = EntryRoute.decide(state: .awaitingOtp(email: "a@b.c"), welcomeSeen: true, wantsSignIn: true, localVaultId: "v1")
        #expect(route == .signIn(canGoBack: false))
    }

    // MARK: - Persistence

    @Test("the local vault id is minted once, lowercase, and kept")
    func choicePersists() {
        let store = isolatedStore()
        #expect(store.id == nil)
        let first = store.create()
        #expect(first == first.lowercased())
        #expect(UUID(uuidString: first) != nil)
        #expect(store.create() == first)
        #expect(store.id == first)
        #expect(store.isUnattached(first))
    }

    @Test("the local registry lists exactly the local vault")
    func localRegistry() async throws {
        let store = isolatedStore()
        #expect(try await LocalVaultRegistry(store: store).vaults().isEmpty)
        let id = store.create()
        let rows = try await LocalVaultRegistry(store: store).vaults()
        #expect(rows.map(\.id) == [id])
    }

    // MARK: - Attach

    @Test("signing in registers the local vault once, then lists it from the account")
    func attachRegistersOnce() async throws {
        let store = isolatedStore()
        let id = store.create()
        let session = FakeAuthSession(from: .registered)
        let account = VaultSummary(id: id, name: "iPhone", encryptedName: nil, nameNonce: nil)
        let registry = AttachingVaultRegistry(
            inner: ListedVaults(rows: [account]),
            attach: LocalVaultAttach(session: session, store: store)
        )

        let first = try await registry.vaults()
        let second = try await registry.vaults()

        #expect(session.calls.filter { if case .registerVault = $0 { true } else { false } }
            == [.registerVault(id, LocalVaultStore.name)])
        #expect(store.isAttached)
        #expect(first.map(\.id) == [id])
        #expect(second.map(\.id) == [id])
    }

    @Test("no plan keeps the vault local and listed, and nothing is lost")
    func paymentRequiredKeepsLocal() async throws {
        let store = isolatedStore()
        let id = store.create()
        let session = FakeAuthSession(from: .registered)
        session.failRegisterVault(with: ApiError.PaymentRequired(code: nil, message: "no plan"))
        let other = VaultSummary(id: "account-vault", name: "Mac", encryptedName: nil, nameNonce: nil)
        let attach = LocalVaultAttach(session: session, store: store)

        #expect(await attach.run() == .needsPlan)
        let rows = try await AttachingVaultRegistry(inner: ListedVaults(rows: [other]), attach: attach).vaults()

        #expect(!store.isAttached)
        #expect(store.id == id)
        #expect(store.isUnattached(id))
        #expect(rows.map(\.id) == ["account-vault", id])
    }

    @Test("PaymentRequired nested in AuthError still reads as needing a plan")
    func nestedPaymentRequired() {
        #expect(LocalVaultAttach.isPaymentRequired(AuthError.Api(source: .PaymentRequired(code: "SYNC_VAULT_LIMIT_EXCEEDED", message: ""))))
        #expect(!LocalVaultAttach.isPaymentRequired(ApiError.Unauthorized(code: "", message: "")))
    }

    // MARK: - Billing mapping

    @Test("each product id maps to its plan and period, and back")
    func productMapping() {
        #expect(StoreProduct.describe("com.memrynote.app.plus.monthly")! == (.plus, .monthly))
        #expect(StoreProduct.describe("com.memrynote.app.plus.annual")! == (.plus, .annual))
        #expect(StoreProduct.describe("com.memrynote.app.pro.monthly")! == (.pro, .monthly))
        #expect(StoreProduct.describe("com.memrynote.app.pro.annual")! == (.pro, .annual))
        #expect(StoreProduct.describe("com.memrynote.app.believer")! == (.believer, .lifetime))
        #expect(StoreProduct.describe("com.memrynote.app.other") == nil)
        for id in StoreProduct.all {
            let (plan, period) = StoreProduct.describe(id)!
            #expect(StoreProduct.id(plan: plan, period: period) == id)
        }
    }

    @Test("the account card follows session, plan and attach state")
    func cardStates() {
        #expect(AccountCardState.of(hasSession: false, billing: nil, vaultIsUnattached: true) == .local)
        #expect(AccountCardState.of(hasSession: true, billing: nil, vaultIsUnattached: true) == .needsPlan(email: nil))
        let free = status(plan: "free", status: "inactive")
        #expect(AccountCardState.of(hasSession: true, billing: free, vaultIsUnattached: false) == .free(email: "a@b.c"))
        let pro = status(plan: "pro", status: "active", store: "app_store")
        #expect(AccountCardState.of(hasSession: true, billing: pro, vaultIsUnattached: false) == .paid(pro))
    }

    @Test("an active web subscription hides the App Store purchase")
    func paddleHidesPurchase() {
        #expect(BillingFacts.hidesPurchase(status(plan: "pro", status: "active", store: "paddle")))
        #expect(!BillingFacts.hidesPurchase(status(plan: "pro", status: "active", store: "app_store")))
        #expect(!BillingFacts.hidesPurchase(status(plan: "pro", status: "canceled", store: "paddle")))
        #expect(BillingFacts.isActivationPending(status(plan: "pro", status: "inactive")))
    }

    @Test("the web checkout carries the token in the fragment")
    func checkoutURL() {
        #expect(PlansLinks.checkout(token: "abc")?.absoluteString == "https://memrynote.com/account/sync#token=abc")
    }
}
