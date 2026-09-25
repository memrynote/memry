import MemryCore
import SwiftUI

// Spec 006 ST38, artboards 23 / 24. The vault open on this iPhone, the other
// vaults in the account (tap to switch to it, which downloads it), and swipe
// to delete from the account after a confirmation. The open vault has no
// swipe: it cannot be deleted from inside itself.
struct VaultsScreen: View {
    let context: SettingsContext
    @State private var vaults: [VaultSummary] = []
    @State private var failure: UserFacingError?
    @State private var deleting: VaultSummary?

    var body: some View {
        List {
            if let failure { Section { ErrorNotice(error: failure, code: nil) } }
            Section(SettingsCopy.onThisPhone) {
                ForEach(vaults.filter { $0.id == context.vaultId }, id: \.id) { vault in
                    SettingsRowLabel(title: name(vault), symbol: "externaldrive.fill", value: SettingsCopy.currentVault)
                }
            }
            Section {
                ForEach(vaults.filter { $0.id != context.vaultId }, id: \.id) { vault in
                    Button {
                        Task { await context.vaults.open(vault) }
                    } label: {
                        SettingsRowLabel(title: name(vault), symbol: "externaldrive", value: SettingsCopy.openVault)
                    }
                    .accessibilityIdentifier("settings.vault.\(vault.id)")
                    .swipeActions(edge: .trailing) {
                        Button(SettingsCopy.deleteFromAccount, role: .destructive) { deleting = vault }
                    }
                }
            } header: {
                Text(SettingsCopy.inAccount)
            } footer: {
                SettingsFooter(SettingsCopy.vaultsFooter(context.account.billing?.maxVaults))
            }
        }
        .settingsList()
        .navigationTitle(SettingsCopy.vaults)
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .refreshable { await load() }
        .confirmationDialog(
            SettingsCopy.deleteVaultTitle(deleting.map(name) ?? ""),
            isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
            titleVisibility: .visible
        ) {
            Button(SettingsCopy.deleteFromAccount, role: .destructive) { let vault = deleting; Task { await delete(vault) } }
        } message: {
            Text(SettingsCopy.deleteVaultMessage)
        }
    }

    private func name(_ vault: VaultSummary) -> String {
        guard let name = vault.name, !name.isEmpty else { return SettingsCopy.unnamedVault }
        return name
    }

    private func load() async {
        do {
            vaults = try await context.vaults.accountVaults()
            failure = nil
        } catch {
            failure = ErrorMapping.userFacing(error)
        }
    }

    private func delete(_ vault: VaultSummary?) async {
        guard let vault, vault.id != context.vaultId else { return }
        deleting = nil
        if let error = await context.account.deleteVault(vault.id) {
            failure = error
        } else {
            vaults.removeAll { $0.id == vault.id }
        }
    }
}
