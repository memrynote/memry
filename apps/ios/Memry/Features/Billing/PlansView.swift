import MemryCore
import StoreKit
import SwiftUI

// The plans sheet. Prices come from StoreKit and are never written here.
//
// A plan belongs to the account, so a signed-out phone is sent to sign-in
// first and the sheet returns once a signed-in vault opens (`BillingRouter`).
// The web checkout is offered beside the App Store in every storefront.
struct PlansView: View {
    /// `nil` when signed out.
    let session: (any AuthSessionProtocol)?
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @Environment(\.startSignIn) private var startSignIn
    @State private var store = StoreKitBilling.shared
    @State private var yearly = true
    @State private var selected = PaidPlan.pro
    @State private var working = false
    @State private var failure: UserFacingError?
    @State private var notice: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Tokens.Space.section) {
                    header
                    if BillingFacts.hidesPurchase(store.billing) {
                        paddleActive
                    } else {
                        Picker(BillingCopy.yearly, selection: $yearly) {
                            Text(BillingCopy.monthly).tag(false)
                            Text(savingsLabel).tag(true)
                        }
                        .pickerStyle(.segmented)
                        .accessibilityIdentifier("plans.period")
                        cards
                        if let failure { ErrorNotice(error: failure, code: nil) }
                        if let notice { noticeText(notice) }
                        purchase
                    }
                    webRow
                    restore
                    footer
                }
                .padding(.horizontal, Tokens.Space.screenInline)
                .padding(.vertical, Tokens.Space.section)
            }
            .background(Tokens.Canvas.background.color)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(BillingCopy.close) { dismiss() }
                }
            }
            .task {
                store.start()
                await store.loadProducts()
            }
            .disabled(working)
        }
        .accessibilityIdentifier("plans.root")
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.small) {
            Text(BillingCopy.plansTitle)
                .font(Tokens.Typography.welcomeHeadline.font)
                .foregroundStyle(Tokens.Text.primary.color)
                .accessibilityAddTraits(.isHeader)
            Text(BillingCopy.plansSubtitle)
                .font(Tokens.Typography.body.font)
                .foregroundStyle(Tokens.Text.secondary.color)
        }
        .accessibilityElement(children: .combine)
    }

    private var period: BillingPeriod { yearly ? .annual : .monthly }

    private var cards: some View {
        VStack(spacing: Tokens.Space.medium) {
            ForEach(PaidPlan.allCases, id: \.self) { plan in
                PlanCard(
                    plan: plan,
                    price: price(plan),
                    isSelected: selected == plan
                ) { selected = plan }
            }
            if store.isLoading, store.products.isEmpty {
                ProgressView().frame(maxWidth: .infinity)
            }
            if let failure = store.loadFailure { ErrorNotice(error: failure, code: nil) }
        }
    }

    private func price(_ plan: PaidPlan) -> String? {
        guard let product = store.product(plan, period) else { return nil }
        switch plan {
        case .believer: return product.displayPrice
        case .plus, .pro: return "\(product.displayPrice)/\(yearly ? BillingCopy.year : BillingCopy.month)"
        }
    }

    /// "Yearly · Save 20%", from the Pro prices; plain "Yearly" until they load.
    private var savingsLabel: String {
        guard let monthly = store.product(.pro, .monthly)?.price,
              let annual = store.product(.pro, .annual)?.price,
              monthly > 0
        else { return BillingCopy.yearly }
        let full = NSDecimalNumber(decimal: monthly * 12).doubleValue
        let percent = Int(((full - NSDecimalNumber(decimal: annual).doubleValue) / full * 100).rounded(.down))
        return percent > 0 ? "\(BillingCopy.yearly) · \(BillingCopy.save(percent))" : BillingCopy.yearly
    }

    @ViewBuilder
    private var purchase: some View {
        VStack(spacing: Tokens.Space.small) {
            if session == nil {
                Button(BillingCopy.signInToSubscribe) { signInFirst() }
                    .memryPrimaryAction()
                Text(BillingCopy.signInReason)
                    .font(Tokens.Typography.caption.font)
                    .foregroundStyle(Tokens.Text.secondary.color)
            } else {
                Button(purchaseTitle) { Task { await buy() } }
                    .memryPrimaryAction()
                    .disabled(store.product(selected, period) == nil)
                    .accessibilityIdentifier("plans.purchase")
                Text(BillingCopy.billedByApple)
                    .font(Tokens.Typography.caption.font)
                    .foregroundStyle(Tokens.Text.secondary.color)
            }
        }
        .frame(maxWidth: .infinity)
    }

    private var purchaseTitle: String {
        guard let product = store.product(selected, period) else { return BillingCopy.subscribe("…", "…") }
        if selected == .believer { return BillingCopy.buy(product.displayPrice) }
        return BillingCopy.subscribe(product.displayPrice, yearly ? BillingCopy.year : BillingCopy.month)
    }

    private var paddleActive: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.tight) {
            Text(BillingCopy.paddleActive)
                .font(Tokens.Typography.heading.font)
                .foregroundStyle(Tokens.Text.primary.color)
            Text(BillingCopy.paddleActiveDetail)
                .font(Tokens.Typography.supporting.font)
                .foregroundStyle(Tokens.Text.secondary.color)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .blockSurface()
        .accessibilityElement(children: .combine)
    }

    private var webRow: some View {
        ChoiceRow(symbol: "safari", title: BillingCopy.payOnWeb, detail: BillingCopy.payOnWebDetail) {
            Task { await payOnWeb() }
        }
        .accessibilityIdentifier("plans.web")
    }

    private var restore: some View {
        Button(BillingCopy.restore) { Task { await restorePurchases() } }
            .memrySecondaryAction()
            .disabled(session == nil)
    }

    private var footer: some View {
        VStack(spacing: Tokens.Space.small) {
            Text(BillingCopy.footer)
            HStack(spacing: Tokens.Space.small) {
                if let terms = PlansLinks.terms { Link(BillingCopy.terms, destination: terms) }
                Text("·").accessibilityHidden(true)
                if let privacy = PlansLinks.privacy { Link(BillingCopy.privacy, destination: privacy) }
            }
        }
        .font(Tokens.Typography.caption.font)
        .foregroundStyle(Tokens.Text.secondary.color)
        .tint(Tokens.Text.primary.color)
        .frame(maxWidth: .infinity)
    }

    private func noticeText(_ text: String) -> some View {
        Text(text)
            .font(Tokens.Typography.supporting.font)
            .foregroundStyle(Tokens.Text.secondary.color)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Actions

    private func signInFirst() {
        // The sheet comes back once the signed-in vault opens.
        BillingRouter.shared.showsPlans = true
        dismiss()
        startSignIn?()
    }

    private func buy() async {
        working = true
        defer { working = false }
        failure = nil
        notice = nil
        switch await store.purchase(StoreProduct.id(plan: selected, period: period)) {
        case .purchased: notice = BillingCopy.thanks
        case .pending: notice = BillingCopy.purchasePending
        case .cancelled: break
        case let .failed(error): failure = error
        }
    }

    private func restorePurchases() async {
        working = true
        defer { working = false }
        failure = await store.restore()
        if failure == nil { notice = BillingCopy.restored }
    }

    /// Desktop's web checkout: a short-lived token in the URL fragment, so the
    /// page knows the account without a second sign-in.
    private func payOnWeb() async {
        guard let session else {
            signInFirst()
            return
        }
        working = true
        defer { working = false }
        do {
            let token = try await session.checkoutToken()
            guard let url = PlansLinks.checkout(token: token.token) else { return }
            openURL(url)
        } catch {
            let mapped = ErrorMapping.userFacing(error)
            Log.app.error("the web checkout could not start", .code(mapped.code))
            failure = mapped
        }
    }
}

enum PlansLinks {
    static let terms = URL(string: "https://memrynote.com/terms")
    static let privacy = URL(string: "https://memrynote.com/privacy")

    static func checkout(token: String) -> URL? {
        var components = URLComponents(string: "https://memrynote.com/account/sync")
        var fragment = URLComponents()
        fragment.queryItems = [URLQueryItem(name: "token", value: token)]
        components?.percentEncodedFragment = fragment.percentEncodedQuery
        return components?.url
    }
}

/// One plan. Selected is a tinted ring and a filled check, never colour alone.
private struct PlanCard: View {
    let plan: PaidPlan
    let price: String?
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(alignment: .top, spacing: Tokens.Space.inset) {
                VStack(alignment: .leading, spacing: Tokens.Space.tight) {
                    HStack(spacing: Tokens.Space.small) {
                        Text(plan.title)
                            .font(Tokens.Typography.heading.font)
                            .foregroundStyle(Tokens.Text.primary.color)
                        if let tag {
                            Text(tag)
                                .font(Tokens.Typography.caption.font.weight(.semibold))
                                .foregroundStyle(Tokens.Text.tint.color)
                                .padding(.horizontal, Tokens.Space.small)
                                .padding(.vertical, 2)
                                .background(Tokens.Tint.base.color.opacity(0.12), in: .capsule)
                        }
                    }
                    Text(limits)
                        .font(Tokens.Typography.supporting.font)
                        .foregroundStyle(Tokens.Text.secondary.color)
                        .multilineTextAlignment(.leading)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                VStack(alignment: .trailing, spacing: Tokens.Space.tight) {
                    Text(price ?? "—")
                        .font(Tokens.Typography.heading.font)
                        .foregroundStyle(Tokens.Text.primary.color)
                    Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                        .foregroundStyle(isSelected ? Tokens.Tint.base.color : Tokens.Line.border.color)
                        .accessibilityHidden(true)
                }
            }
            .padding(Tokens.Space.inset)
            .background(
                RoundedRectangle(cornerRadius: Tokens.Radius.panel)
                    .stroke(isSelected ? Tokens.Tint.base.color : Tokens.Line.border.color,
                            lineWidth: isSelected ? 2 : Tokens.Size.hairline)
            )
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel([plan.title, tag, price, limits].compactMap { $0 }.joined(separator: ", "))
        .accessibilityAddTraits(isSelected ? [.isButton, .isSelected] : .isButton)
        .accessibilityIdentifier("plans.card.\(plan.rawValue)")
    }

    private var tag: String? {
        switch plan {
        case .pro: BillingCopy.popular
        case .believer: BillingCopy.oneTime
        case .plus: nil
        }
    }

    private var limits: String {
        switch plan {
        case .plus: BillingCopy.plusLimits
        case .pro: BillingCopy.proLimits
        case .believer: BillingCopy.believerLimits
        }
    }
}
