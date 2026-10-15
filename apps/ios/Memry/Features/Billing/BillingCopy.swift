import Foundation
import MemryCore
import Observation
import SwiftUI

// Every sentence the plans sheet and the account card show, and the two
// app-wide routes into them.

enum BillingCopy {
    static let plansTitle = "Your vault, on every device."
    static let plansSubtitle = "Memry stays free on this phone. Sync is end-to-end encrypted — we never see your notes."
    static let monthly = "Monthly"
    static let yearly = "Yearly"
    static func save(_ percent: Int) -> String { "Save \(percent)%" }
    static let popular = "POPULAR"
    static let oneTime = "One time"
    static let plusLimits = "1 GB · 1 vault · 30-day history"
    static let proLimits = "10 GB · 10 vaults · 1-year history"
    static let believerLimits = "50 GB · unlimited vaults · founder supporter, for life"
    static func subscribe(_ price: String, _ period: String) -> String { "Subscribe · \(price)/\(period)" }
    static func buy(_ price: String) -> String { "Buy · \(price)" }
    static let month = "mo"
    static let year = "yr"
    static let billedByApple = "Billed through the App Store"
    static let payOnWeb = "Pay on memrynote.com"
    static let payOnWebDetail = "Card or PayPal via Paddle · opens Safari"
    static let restore = "Restore purchases"
    static let restored = "Purchases restored."
    static let signInToSubscribe = "Sign in to subscribe"
    static let signInReason = "A plan belongs to your account, so it follows you to every device."
    static let footer = "Cancel anytime. 14-day money-back guarantee."
    static let terms = "Terms"
    static let privacy = "Privacy"
    static let paddleActive = "You subscribe on memrynote.com"
    static let paddleActiveDetail = "Change or cancel your plan from Manage subscription in Account."
    static let purchasePending = "Your purchase is waiting for approval. Sync turns on once it goes through."
    static let thanks = "Sync is on. Thank you for supporting Memry."
    static let close = "Close"

    // Account card
    static let onThisIPhone = "On this iPhone"
    static let localLine = "Free · Not signed in"
    static let localDetail = "Sign in to back up your vault and keep it in step with your Mac."
    static let signIn = "Sign in"
    static let createAccount = "Create account"
    static let freeLine = "Free plan · Sync off"
    static let needsPlanLine = "Sync needs a plan"
    static let needsPlanDetail = "This vault stays on this iPhone until your plan has room for it."
    static let unlockSync = "Unlock sync"
    static func unlockDetail(_ price: String?) -> String {
        guard let price else { return "Encrypted sync across all your devices." }
        return "Encrypted sync across all your devices, from \(price)/mo"
    }

    // Subscription group
    static let subscription = "Subscription"
    static let plan = "Plan"
    static let renews = "Renews"
    static let expires = "Expires"
    static let billedThrough = "Billed through"
    static let appStore = "App Store"
    static let web = "memrynote.com"
    static let manage = "Manage subscription"
    static let refresh = "Refresh status"
    static let activationPending = "Activation pending. The payment can take a moment to confirm. Refresh status, or email support@memrynote.com."

    static func status(_ status: String) -> String {
        switch status {
        case "active": "Active"
        case "past_due": "Past due"
        case "paused": "Paused"
        case "canceled": "Canceled"
        case "inactive": "Inactive"
        default: status.prefix(1).uppercased() + status.dropFirst()
        }
    }

    static func cadence(_ cadence: String?) -> String? {
        switch cadence {
        case "monthly": "Monthly"
        case "annual": "Yearly"
        case "lifetime": "Lifetime"
        default: nil
        }
    }

    static let storeUnavailable = UserFacingError(
        code: "billing.storeUnavailable",
        title: "The App Store could not be reached.",
        guidance: "Check your connection and try again. Nothing was charged.",
        recourse: .retry, isUserVisible: true
    )
    static let signInFirst = UserFacingError(
        code: "billing.signInFirst",
        title: "Sign in to buy a plan.",
        guidance: "A plan belongs to your account. Nothing was charged.",
        recourse: .blocked, isUserVisible: true
    )
    static let noAccountToken = UserFacingError(
        code: "billing.noAccountToken",
        title: "Memry could not link this purchase to your account.",
        guidance: "Nothing was charged. Try again in a moment; if it keeps happening, pay on memrynote.com.",
        recourse: .retryLater, isUserVisible: true
    )
    static let purchaseFailed = UserFacingError(
        code: "billing.purchaseFailed",
        title: "The purchase did not go through.",
        guidance: "Nothing was charged. Try again.",
        recourse: .retry, isUserVisible: true
    )
    static let notConfirmed = UserFacingError(
        code: "billing.notConfirmed",
        title: "Your purchase went through, but Memry has not confirmed it yet.",
        guidance: "You were not charged twice. Memry confirms it the next time it opens, or tap Restore purchases.",
        recourse: .retryLater, isUserVisible: true
    )
    static let restoreFailed = UserFacingError(
        code: "billing.restoreFailed",
        title: "Purchases could not be restored.",
        guidance: "Check that you are signed in to the App Store, then try again.",
        recourse: .retry, isUserVisible: true
    )
    static let manageFailed = UserFacingError(
        code: "billing.manageFailed",
        title: "Subscription settings could not be opened.",
        guidance: "Open Settings › Apple Account › Subscriptions on this iPhone.",
        recourse: .retry, isUserVisible: true
    )
}

/// The app-wide way to the plans sheet. One flag, so the sheet can be asked
/// for before sign-in and appear once a signed-in vault opens.
@MainActor
@Observable
final class BillingRouter {
    static let shared = BillingRouter()
    var showsPlans = false
}

extension EnvironmentValues {
    /// Leaves the local vault for the sign-in flow. `nil` once signed in.
    @Entry var startSignIn: (@MainActor () -> Void)?
}
