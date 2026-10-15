import MemryCore
import StoreKit
import SwiftUI
import UIKit

// Account › Subscription. Mirrors desktop's account section: the plan and its
// status, when it renews or ends, where it is billed, storage and devices,
// and the way to manage it — the App Store sheet for an App Store purchase,
// the web portal for one made on memrynote.com.
struct AccountSubscriptionSection: View {
    let context: SettingsContext
    let storageLine: String?
    let devicesLine: String?
    @Environment(\.openURL) private var openURL
    @State private var store = StoreKitBilling.shared
    @State private var working = false
    @State private var failure: UserFacingError?
    @State private var showsPlans = false

    var body: some View {
        Section {
            if let billing, billing.plan != "free" {
                LabeledContent(BillingCopy.plan) {
                    Text("\(BillingFacts.planLine(billing)) · \(BillingCopy.status(billing.status))")
                }
                .accessibilityIdentifier("settings.account.plan")
                if let renewal = renewalLine(billing) {
                    LabeledContent(renewal.label, value: renewal.value)
                }
                if let through = billedThrough(billing) {
                    LabeledContent(BillingCopy.billedThrough, value: through)
                }
            } else {
                LabeledContent(BillingCopy.plan, value: BillingCopy.freeLine)
                    .accessibilityIdentifier("settings.account.plan")
                SettingsActionRow(title: BillingCopy.unlockSync, symbol: "arrow.triangle.2.circlepath",
                                  identifier: "settings.account.unlockSync") {
                    showsPlans = true
                }
                .sheet(isPresented: $showsPlans) { PlansView(session: context.account.session) }
            }
            SettingsLinkRow(title: SettingsCopy.storage, value: storageLine, route: .storage)
            SettingsLinkRow(title: SettingsCopy.devices, value: devicesLine, route: .devices)
            if BillingFacts.isActivationPending(billing) {
                Text(BillingCopy.activationPending)
                    .font(Tokens.Typography.supporting.font)
                    .foregroundStyle(Tokens.Text.secondary.color)
            }
            if BillingFacts.isActivationPending(billing) || billing?.status == "past_due" {
                SettingsActionRow(title: BillingCopy.refresh, symbol: "arrow.clockwise",
                                  identifier: "settings.account.refreshBilling") {
                    Task { await run { await context.account.refreshBilling() } }
                }
            }
            if canManage {
                SettingsActionRow(title: BillingCopy.manage, symbol: "creditcard",
                                  identifier: "settings.account.manage") {
                    Task { await run { await manage() } }
                }
            }
            if let failure { ErrorNotice(error: failure, code: nil) }
        } header: {
            Text(BillingCopy.subscription)
        }
        .disabled(working)
        .task { await store.loadProducts() }
    }

    private var billing: BillingStatus? { context.account.billing }

    private var canManage: Bool {
        BillingFacts.isAppStore(billing) || (BillingFacts.isWeb(billing) && billing?.canManageBilling != false)
    }

    private func renewalLine(_ billing: BillingStatus) -> (label: String, value: String)? {
        guard let date = BillingFacts.date(billing.expiresAt) else { return nil }
        let renews = billing.willRenew ?? (billing.status == "active")
        var value = date.formatted(date: .abbreviated, time: .omitted)
        if renews, BillingFacts.isAppStore(billing), let plan = PaidPlan(rawValue: billing.plan),
           let price = store.product(plan, billing.cadence == "monthly" ? .monthly : .annual)?.displayPrice {
            value += " · \(price)"
        }
        return (renews ? BillingCopy.renews : BillingCopy.expires, value)
    }

    private func billedThrough(_ billing: BillingStatus) -> String? {
        if BillingFacts.isAppStore(billing) { return BillingCopy.appStore }
        if BillingFacts.isWeb(billing) { return BillingCopy.web }
        return nil
    }

    private func run(_ work: () async -> Void) async {
        working = true
        failure = nil
        await work()
        working = false
    }

    private func manage() async {
        if BillingFacts.isAppStore(billing) {
            guard let scene = UIApplication.shared.connectedScenes
                .first(where: { $0.activationState == .foregroundActive }) as? UIWindowScene
            else {
                failure = BillingCopy.manageFailed
                return
            }
            do {
                try await AppStore.showManageSubscriptions(in: scene)
                await context.account.refreshBilling()
            } catch {
                Log.app.error("the App Store subscriptions sheet failed", .code(BillingCopy.manageFailed.code))
                failure = BillingCopy.manageFailed
            }
            return
        }
        switch await context.account.billingPortal() {
        case let .success(url): openURL(url)
        case let .failure(error): failure = error
        }
    }
}
