import Foundation
import MemryCore
import Observation
import StoreKit

// The one owner of App Store purchases.
//
// **The server decides the entitlement.** A purchase is bound to the account by
// `appAccountToken`, and every verified transaction's JWS goes to the server
// through the core (`submitAppStoreTransaction`). A transaction is finished
// only after the server accepted it, so a purchase made offline or refused by
// a transient error is redelivered by StoreKit and submitted again. One that
// fails StoreKit's own verification is finished: it can never be submitted.

/// A paid plan, as the server names it.
enum PaidPlan: String, CaseIterable, Sendable {
    case plus, pro, believer

    var title: String { rawValue.prefix(1).uppercased() + rawValue.dropFirst() }
}

/// How often a plan bills.
enum BillingPeriod: String, Sendable {
    case monthly, annual, lifetime
}

/// The five products and what each one is.
enum StoreProduct {
    static let plusMonthly = "com.memrynote.app.plus.monthly"
    static let plusAnnual = "com.memrynote.app.plus.annual"
    static let proMonthly = "com.memrynote.app.pro.monthly"
    static let proAnnual = "com.memrynote.app.pro.annual"
    static let believer = "com.memrynote.app.believer"

    static let all = [plusMonthly, plusAnnual, proMonthly, proAnnual, believer]

    static func describe(_ id: String) -> (plan: PaidPlan, period: BillingPeriod)? {
        switch id {
        case plusMonthly: (.plus, .monthly)
        case plusAnnual: (.plus, .annual)
        case proMonthly: (.pro, .monthly)
        case proAnnual: (.pro, .annual)
        case believer: (.believer, .lifetime)
        default: nil
        }
    }

    static func id(plan: PaidPlan, period: BillingPeriod) -> String {
        switch (plan, period) {
        case (.believer, _): believer
        case (.plus, .monthly): plusMonthly
        case (.plus, _): plusAnnual
        case (.pro, .monthly): proMonthly
        case (.pro, _): proAnnual
        }
    }
}

/// The account calls a purchase needs. A slice of `AuthSessionProtocol`, so a
/// test scripts two methods rather than the whole session.
protocol AppStoreBillingAccount: Sendable {
    func billing() async throws -> BillingStatus
    func submitAppStoreTransaction(signedTransactionInfo: String) async throws -> BillingStatus
}

struct SessionBillingAccount: AppStoreBillingAccount {
    let session: any AuthSessionProtocol
    func billing() async throws -> BillingStatus { try await session.billing() }
    func submitAppStoreTransaction(signedTransactionInfo: String) async throws -> BillingStatus {
        try await session.submitAppStoreTransaction(signedTransactionInfo: signedTransactionInfo)
    }
}

@MainActor
@Observable
final class StoreKitBilling {
    static let shared = StoreKitBilling()

    enum PurchaseOutcome: Equatable {
        case purchased
        case pending
        case cancelled
        case failed(UserFacingError)
    }

    private(set) var products: [String: Product] = [:]
    private(set) var isLoading = false
    private(set) var loadFailure: UserFacingError?
    /// The latest status the server returned, from a submit or a read.
    private(set) var billing: BillingStatus?
    /// Set while signed in. Without it nothing is bought and nothing submitted.
    var account: (any AppStoreBillingAccount)? {
        didSet { if account != nil { Task { await submitCurrentEntitlements() } } }
    }
    /// Told when the server accepted a transaction.
    var entitlementChanged: (@MainActor (BillingStatus) -> Void)?

    private var updates: Task<Void, Never>?

    /// Starts listening for transactions made elsewhere: renewals, Ask to Buy,
    /// a purchase on another device. Once per process.
    func start() {
        guard updates == nil else { return }
        updates = Task { [weak self] in
            for await result in Transaction.updates {
                await self?.handle(result)
            }
        }
    }

    func loadProducts() async {
        guard products.isEmpty, !isLoading else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            let loaded = try await Product.products(for: StoreProduct.all)
            products = Dictionary(uniqueKeysWithValues: loaded.map { ($0.id, $0) })
            // An empty answer is a store that has no products for this build,
            // and must not render as prices that are merely late.
            loadFailure = loaded.isEmpty ? BillingCopy.storeUnavailable : nil
            Log.app.info("loaded store products", .count(loaded.count))
        } catch {
            loadFailure = BillingCopy.storeUnavailable
            Log.app.error("store products could not be loaded", .code(BillingCopy.storeUnavailable.code))
        }
    }

    func product(_ plan: PaidPlan, _ period: BillingPeriod) -> Product? {
        products[StoreProduct.id(plan: plan, period: period)]
    }

    /// Buys one product for the signed-in account.
    func purchase(_ productId: String) async -> PurchaseOutcome {
        guard let account else { return .failed(BillingCopy.signInFirst) }
        guard let product = products[productId] else { return .failed(BillingCopy.storeUnavailable) }
        // The token binds the purchase to this account. Read fresh: a status
        // from an older server, or none at all, has no token to bind with.
        let status: BillingStatus
        do {
            status = try await account.billing()
            billing = status
        } catch {
            return .failed(ErrorMapping.userFacing(error))
        }
        guard let token = status.appAccountToken.flatMap(UUID.init(uuidString:)) else {
            Log.app.error("refused a purchase with no account token", .code(BillingCopy.noAccountToken.code))
            return .failed(BillingCopy.noAccountToken)
        }
        do {
            let result = try await product.purchase(options: [.appAccountToken(token)])
            switch result {
            case let .success(verification):
                return await handle(verification) ? .purchased : .failed(BillingCopy.notConfirmed)
            case .pending:
                return .pending
            case .userCancelled:
                return .cancelled
            @unknown default:
                return .cancelled
            }
        } catch {
            Log.app.error("an App Store purchase failed", .code(BillingCopy.purchaseFailed.code))
            return .failed(BillingCopy.purchaseFailed)
        }
    }

    /// Restore: asks the App Store for this Apple ID's purchases, then submits
    /// every current entitlement again.
    func restore() async -> UserFacingError? {
        do {
            try await AppStore.sync()
        } catch {
            Log.app.error("App Store sync failed", .code(BillingCopy.restoreFailed.code))
            return BillingCopy.restoreFailed
        }
        await submitCurrentEntitlements()
        return nil
    }

    /// Hands every current entitlement to the server. Run at sign-in and after
    /// a restore, so a purchase whose submit failed is not left unrecorded.
    func submitCurrentEntitlements() async {
        guard account != nil else { return }
        for await result in Transaction.currentEntitlements {
            await handle(result)
        }
    }

    /// - Returns: `true` when the server accepted the transaction.
    @discardableResult
    private func handle(_ result: VerificationResult<Transaction>) async -> Bool {
        switch result {
        case let .unverified(transaction, _):
            // Never valid, so never submitted; finishing stops redelivery.
            Log.app.error("finished an unverified App Store transaction", .code("billing.unverified"))
            await transaction.finish()
            return false
        case let .verified(transaction):
            guard let account else { return false }
            do {
                let status = try await account.submitAppStoreTransaction(signedTransactionInfo: result.jwsRepresentation)
                billing = status
                await transaction.finish()
                entitlementChanged?(status)
                return true
            } catch {
                // Left unfinished: StoreKit delivers it again and it is retried.
                let mapped = ErrorMapping.userFacing(error)
                Log.app.error("the server did not accept an App Store transaction", .code(mapped.code))
                return false
            }
        }
    }
}
