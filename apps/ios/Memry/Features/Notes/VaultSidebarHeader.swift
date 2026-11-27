import SwiftUI

// The sidebar's header at regular width (`DESIGN.md` › Tablet, D2): the vault
// name and its sync status, as on desktop. A tap opens the vault switcher.
// With one vault on the account there is nothing to switch to, so the header
// is plain text, like Home's switch button that is absent then.

struct VaultSidebarHeader: View {
    let name: String
    /// `nil` until the vault's settings context exists; the header then shows
    /// the name alone.
    let context: SettingsContext?
    let switchVault: (() -> Void)?

    var body: some View {
        if let switchVault {
            Button(action: switchVault) { label }
                .buttonStyle(.plain)
                .pointerHover(.row)
                .accessibilityHint("Switch vault")
                .accessibilityIdentifier("sidebar.vault")
        } else {
            label.accessibilityIdentifier("sidebar.vault")
        }
    }

    private var label: some View {
        let status = context.map(SyncStatusText.sidebar)
        return VStack(alignment: .leading, spacing: Tokens.Space.tight) {
            Text(name)
                .font(Tokens.Typography.heading.font)
                .foregroundStyle(Tokens.Text.primary.color)
            if let status {
                HStack(spacing: Tokens.Space.small) {
                    if let dot = status.dot { SyncDot(state: dot) }
                    Text(status.line)
                        .font(Tokens.Typography.supporting.font)
                        .foregroundStyle(Tokens.Text.secondary.color)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

extension SyncStatusText {
    /// The header's line: the pass state for a vault that syncs, otherwise
    /// the same plan line the Settings account card shows.
    static func sidebar(_ context: SettingsContext) -> (line: String, dot: SyncDot.State?) {
        let state = AccountCardState.of(
            hasSession: context.account.hasSession,
            billing: context.account.billing,
            vaultIsUnattached: LocalVaultStore().isUnattached(context.vaultId)
        )
        switch state {
        case .local: return (BillingCopy.localLine, nil)
        case .needsPlan: return (BillingCopy.needsPlanLine, nil)
        case .free: return (BillingCopy.freeLine, nil)
        case .paid: return (status(context), dot(context))
        }
    }
}
