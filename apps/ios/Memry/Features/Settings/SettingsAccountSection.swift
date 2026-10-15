import MemryCore
import StoreKit
import SwiftUI

// The account card at the top of Settings, in its four states: the free
// vault on this iPhone, a signed-in vault that needs a plan, a free account,
// and a paid one. Only the paid card opens Account; the others lead to
// sign-in or to the plans sheet.
struct SettingsAccountSection: View {
    let context: SettingsContext
    @Environment(\.startSignIn) private var startSignIn
    @State private var store = StoreKitBilling.shared
    /// Presented from here: Settings is itself presented, so the vault-level
    /// sheet cannot show over it.
    @State private var showsPlans = false

    var body: some View {
        switch state {
        case .local:
            Section {
                VStack(alignment: .leading, spacing: Tokens.Space.medium) {
                    SettingsAccountCard(title: BillingCopy.onThisIPhone, line: BillingCopy.localLine, dot: nil)
                    Text(BillingCopy.localDetail)
                        .font(Tokens.Typography.supporting.font)
                        .foregroundStyle(Tokens.Text.secondary.color)
                    HStack(spacing: Tokens.Space.small) {
                        Button(BillingCopy.signIn) { startSignIn?() }
                            .memryPrimaryAction()
                            .accessibilityIdentifier("settings.account.signIn")
                        Button(BillingCopy.createAccount) { startSignIn?() }
                            .memrySecondaryAction()
                            .accessibilityIdentifier("settings.account.createAccount")
                    }
                }
                .padding(.vertical, Tokens.Space.tight)
            }
            unlockSection
        case let .needsPlan(email):
            Section {
                NavigationLink(value: SettingsRoute.account) {
                    SettingsAccountCard(email: email, line: BillingCopy.needsPlanLine, dot: .offline)
                }
                .accessibilityIdentifier("settings.row.account")
            } footer: {
                SettingsFooter(BillingCopy.needsPlanDetail)
            }
            unlockSection
        case let .free(email):
            Section {
                NavigationLink(value: SettingsRoute.account) {
                    SettingsAccountCard(email: email, line: BillingCopy.freeLine, dot: .offline)
                }
                .accessibilityIdentifier("settings.row.account")
            }
            unlockSection
        case .paid:
            Section {
                NavigationLink(value: SettingsRoute.account) {
                    SettingsAccountCard(
                        email: context.account.email,
                        line: SyncStatusText.cardLine(context),
                        dot: SyncStatusText.dot(context)
                    )
                }
                .accessibilityIdentifier("settings.row.account")
            }
        }
    }

    private var state: AccountCardState {
        AccountCardState.of(
            hasSession: context.account.hasSession,
            billing: context.account.billing,
            vaultIsUnattached: LocalVaultStore().isUnattached(context.vaultId)
        )
    }

    /// The one tinted row: the way to the plans sheet.
    private var unlockSection: some View {
        Section {
            // A row of the grouped list, not `ChoiceRow`: its own border would
            // draw a card inside the list's card.
            Button { showsPlans = true } label: {
                HStack(spacing: Tokens.Space.medium) {
                    Image(systemName: "arrow.triangle.2.circlepath")
                        .font(Tokens.Typography.heading.font)
                        .foregroundStyle(Tokens.Tint.base.color)
                        .frame(width: Tokens.Size.minimumHitArea, height: Tokens.Size.minimumHitArea)
                        .background(Tokens.Tint.base.color.opacity(0.1), in: .rect(cornerRadius: Tokens.Radius.card))
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: Tokens.Space.tight) {
                        Text(BillingCopy.unlockSync)
                            .font(Tokens.Typography.heading.font)
                            .foregroundStyle(Tokens.Text.primary.color)
                        Text(BillingCopy.unlockDetail(store.product(.plus, .monthly)?.displayPrice))
                            .font(Tokens.Typography.supporting.font)
                            .foregroundStyle(Tokens.Text.secondary.color)
                            .multilineTextAlignment(.leading)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    Image(systemName: "chevron.forward")
                        .font(Tokens.Typography.supporting.font)
                        .foregroundStyle(Tokens.Text.secondary.color)
                        .accessibilityHidden(true)
                }
                .padding(.vertical, Tokens.Space.tight)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isButton)
            .sheet(isPresented: $showsPlans) { PlansView(session: context.account.session) }
            .accessibilityIdentifier("settings.account.unlockSync")
        }
        .task { await store.loadProducts() }
    }
}
