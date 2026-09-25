import MemryCore
import SwiftUI

// Spec 006 ST31 / ST37, artboards 02 and 08. Identity with the E2E badge,
// sync (status, Sync now, attachment downloads), plan read-only (F8), storage
// and devices, and the one Sign out (F1), reusing `AccountViewModel` and its
// confirmation copy.
struct AccountScreen: View {
    let context: SettingsContext
    @Environment(AccountViewModel.self) private var signOut: AccountViewModel?
    @State private var local = LocalSettings.shared

    var body: some View {
        List {
            Section {
                SettingsAccountCard(
                    email: context.account.email,
                    line: SyncStatusText.status(context),
                    dot: SyncStatusText.dot(context),
                    showsBadge: true
                )
            }
            if let failure = context.account.failure {
                Section { ErrorNotice(error: failure, code: nil).listRowInsets(EdgeInsets()) }
            }
            Section {
                LabeledContent(SettingsCopy.status, value: SyncStatusText.status(context))
                    .accessibilityIdentifier("settings.account.status")
                SettingsActionRow(title: SettingsCopy.syncNow, symbol: "arrow.triangle.2.circlepath",
                                  identifier: "settings.account.syncNow") {
                    Task { await context.tasks.sync() }
                }
                .disabled(context.tasks.isSyncing)
                Picker(SettingsCopy.downloadAttachments, selection: $local.attachmentDownload) {
                    Text(SettingsCopy.downloadAlways).tag(AttachmentDownload.always)
                    Text(SettingsCopy.downloadWifi).tag(AttachmentDownload.wifi)
                    Text(SettingsCopy.downloadNever).tag(AttachmentDownload.never)
                }
                .pickerStyle(.menu)
                .accessibilityIdentifier("settings.account.download")
            } header: {
                Text(SettingsCopy.syncGroup)
            } footer: {
                SettingsFooter(SettingsCopy.downloadFooter)
            }
            Section {
                LabeledContent(SettingsCopy.plan, value: planLine)
                    .accessibilityIdentifier("settings.account.plan")
                SettingsLinkRow(title: SettingsCopy.storage, value: storageLine, route: .storage)
                SettingsLinkRow(title: SettingsCopy.devices, value: devicesLine, route: .devices)
            } header: {
                Text(SettingsCopy.planAndDevices)
            } footer: {
                SettingsFooter(SettingsCopy.planFooter)
            }
            if let signOut {
                SignOutSection(model: signOut)
            }
        }
        .settingsList()
        .navigationTitle(SettingsCopy.account)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            await context.account.load()
            await context.account.loadStorage()
            await context.account.loadDevices()
        }
    }

    private var planLine: String {
        guard let billing = context.account.billing else { return "—" }
        return SettingsCopy.planLine(SettingsLabels.plan(billing.plan), SettingsLabels.plan(billing.status))
    }

    private var storageLine: String? {
        guard let storage = context.account.storage else { return nil }
        return SettingsCopy.storageLine(ByteCountFormatter.memry(storage.used), ByteCountFormatter.memry(storage.limit))
    }

    private var devicesLine: String? {
        context.account.devices.isEmpty ? nil : "\(context.account.devices.count)"
    }
}

/// Artboard 08. The existing sign-out flow (T159), moved onto Account.
private struct SignOutSection: View {
    @Bindable var model: AccountViewModel

    var body: some View {
        Section {
            if model.isWorking {
                Label(AccountCopy.signingOut, systemImage: "hourglass")
                    .foregroundStyle(Tokens.Text.secondary.color)
            } else {
                SettingsDestructiveRow(title: AccountCopy.signOut, identifier: "settings.account.signOut") {
                    model.isConfirming = true
                }
            }
            if let residue = model.residue { ErrorNotice(error: residue, code: nil) }
            if let error = model.error { ErrorNotice(error: error, code: nil) }
        }
        .confirmationDialog(AccountCopy.confirmTitle, isPresented: $model.isConfirming, titleVisibility: .visible) {
            Button(AccountCopy.signOut, role: .destructive) {
                Task { await model.signOut() }
            }
        } message: {
            Text(AccountCopy.confirmMessage)
        }
    }
}
