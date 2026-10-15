import Foundation
import MemryCore

/// Which account card Settings shows, decided in one place.
enum AccountCardState: Equatable {
    /// No session: the free path's vault on this iPhone.
    case local
    /// Signed in, and this vault is the local one the account could not take.
    case needsPlan(email: String?)
    /// Signed in with no paid plan (or the status has not loaded yet).
    case free(email: String?)
    /// Signed in on a paid plan, whatever its status.
    case paid(BillingStatus)

    static func of(hasSession: Bool, billing: BillingStatus?, vaultIsUnattached: Bool) -> AccountCardState {
        guard hasSession else { return .local }
        if vaultIsUnattached { return .needsPlan(email: billing?.email) }
        guard let billing, billing.plan != "free" else { return .free(email: billing?.email) }
        return .paid(billing)
    }
}

/// What Plans and Account read off one billing status.
enum BillingFacts {
    static func isAppStore(_ billing: BillingStatus?) -> Bool { billing?.store == "app_store" }
    static func isWeb(_ billing: BillingStatus?) -> Bool { billing?.store == "paddle" }

    /// A web subscription that is running: the App Store must not sell a
    /// second one on top of it.
    static func hidesPurchase(_ billing: BillingStatus?) -> Bool {
        guard let billing else { return false }
        return isWeb(billing) && billing.status == "active" && billing.plan != "free"
    }

    /// Desktop's "activation pending": a plan is named and it is not active.
    static func isActivationPending(_ billing: BillingStatus?) -> Bool {
        guard let billing else { return false }
        return billing.plan != "free" && billing.status == "inactive"
    }

    /// `Pro · Yearly`, or `Pro` when the cadence is unknown.
    static func planLine(_ billing: BillingStatus) -> String {
        let plan = PaidPlan(rawValue: billing.plan)?.title ?? SettingsLabels.plan(billing.plan)
        guard let cadence = BillingCopy.cadence(billing.cadence) else { return plan }
        return "\(plan) · \(cadence)"
    }

    /// The server sends seconds or milliseconds.
    static func date(_ epoch: Int64?) -> Date? {
        guard let epoch, epoch > 0 else { return nil }
        let seconds = epoch > 10_000_000_000 ? epoch / 1000 : epoch
        return Date(timeIntervalSince1970: TimeInterval(seconds))
    }
}
