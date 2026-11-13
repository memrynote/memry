import MemryCore
import SwiftUI

// Spec 006 ST33–ST36, artboards 04–07. This device first (no swipe: it cannot
// revoke itself), then the others by last seen, five before "Show more"
// (desktop). Long press renames (alert with a field), swipe revokes after a
// confirmation, and Link new device opens the approver sheet.
struct DevicesScreen: View {
    let context: SettingsContext
    @State private var showsAll = false
    @State private var renaming: AccountDevice?
    @State private var draftName = ""
    @State private var revoking: AccountDevice?
    @State private var linking = false
    @State private var showsPlans = false
    @State private var notice: String?
    @State private var failure: UserFacingError?

    var body: some View {
        List {
            if let failure { Section { ErrorNotice(error: failure, code: nil) } }
            if let current = context.account.thisDevice {
                Section(SettingsCopy.thisDeviceGroup) { row(current) }
            }
            Section {
                ForEach(visibleOthers, id: \.id) { device in
                    row(device)
                        .swipeActions(edge: .trailing) {
                            // Tinted, not `role: .destructive`: a destructive swipe
                            // removes the row, and the confirmation on it with it.
                            Button(SettingsCopy.revoke) { revoking = device }
                                .tint(.red)
                                .accessibilityIdentifier("settings.devices.revoke")
                        }
                        // On the row, so the popover points at it on iPad.
                        .confirmationDialog(
                            SettingsCopy.revokeTitle(device.name),
                            isPresented: Binding(get: { revoking?.id == device.id }, set: { if !$0 { revoking = nil } }),
                            titleVisibility: .visible
                        ) {
                            Button(SettingsCopy.revokeDevice, role: .destructive) { Task { await revoke(device) } }
                        } message: {
                            Text(SettingsCopy.revokeMessage)
                        }
                }
                if !showsAll, context.account.otherDevices.count > 5 {
                    Button(SettingsCopy.showMore(context.account.otherDevices.count - 5)) { showsAll = true }
                }
            } header: {
                Text(SettingsCopy.otherDevices)
            } footer: {
                SettingsFooter(SettingsCopy.devicesFooter)
            }
            Section {
                SettingsActionRow(title: SettingsCopy.linkNewDevice, symbol: "qrcode",
                                  identifier: "settings.devices.link") {
                    // Linking needs a plan (the server answers 402 without
                    // one), so an unpaid account goes to the plans instead.
                    if BillingFacts.isKnownUnpaid(context.account.billing) { showsPlans = true } else { linking = true }
                }
            } footer: {
                SettingsFooter(SettingsCopy.linkFooter)
            }
        }
        .settingsList()
        .navigationTitle(SettingsCopy.devices)
        .navigationBarTitleDisplayMode(.inline)
        .overlay(alignment: .bottom) { SettingsToast(text: $notice) }
        .task { await context.account.loadDevices() }
        .refreshable { await context.account.loadDevices() }
        .alert(SettingsCopy.renameDevice, isPresented: isRenaming) {
            TextField(SettingsCopy.renameDevice, text: $draftName)
                .accessibilityIdentifier("settings.devices.renameField")
            Button(SettingsCopy.cancel, role: .cancel) {}
            Button(SettingsCopy.rename) { let device = renaming; Task { await rename(device) } }
                .disabled(draftName.trimmingCharacters(in: .whitespaces).isEmpty)
        }
        .sheet(isPresented: $linking, onDismiss: { Task { await context.account.loadDevices() } }) {
            LinkDeviceSheet(account: context.account)
        }
        .sheet(isPresented: $showsPlans) { PlansView(session: context.account.session) }
    }

    private var visibleOthers: [AccountDevice] {
        let others = context.account.otherDevices
        return showsAll ? others : Array(others.prefix(5))
    }

    private func row(_ device: AccountDevice) -> some View {
        SettingsRowLabel(
            title: device.name,
            symbol: Self.symbol(device),
            detail: detail(device)
        )
        .contentShape(.rect)
        .contextMenu {
            Button(SettingsCopy.rename, systemImage: "pencil") {
                draftName = device.name
                renaming = device
            }
        }
        .accessibilityIdentifier("settings.device.\(device.name)")
        .accessibilityAction(named: SettingsCopy.rename) {
            draftName = device.name
            renaming = device
        }
    }

    private func detail(_ device: AccountDevice) -> String {
        let platform = Self.platformName(device.platform)
        if device.isCurrent { return "\(platform) · \(SettingsCopy.thisDeviceLabel)" }
        guard let seen = device.lastSyncAt else { return "\(platform) · \(SettingsCopy.neverSeen)" }
        let date = Date(timeIntervalSince1970: TimeInterval(seen > 10_000_000_000 ? seen / 1000 : seen))
        return "\(platform) · \(SettingsCopy.lastSeen(SettingsLabels.relative(date)))"
    }

    static func platformName(_ platform: String) -> String {
        switch platform.lowercased() {
        case "ios": "iOS"
        case "macos": "macOS"
        case "windows": "Windows"
        case "linux": "Linux"
        case "android": "Android"
        default: platform
        }
    }

    /// Chapter 02 §2.3.4: the form factor when the device reported one, else
    /// `platform`, which draws every iPad registered before #4375 as a phone.
    static func symbol(_ device: AccountDevice) -> String {
        switch device.formFactor {
        case .tablet: "ipad"
        case .phone: "iphone"
        case nil:
            switch device.platform.lowercased() {
            case "ios", "android": "iphone"
            default: "laptopcomputer"
            }
        }
    }

    private var isRenaming: Binding<Bool> {
        Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })
    }

    private func rename(_ device: AccountDevice?) async {
        guard let device else { return }
        let name = draftName.trimmingCharacters(in: .whitespaces)
        renaming = nil
        if let error = await context.account.rename(device, to: name) {
            failure = error
        } else {
            failure = nil
            notice = SettingsCopy.renamedTo(name)
        }
    }

    private func revoke(_ device: AccountDevice) async {
        revoking = nil
        failure = await context.account.revoke(device)
    }
}

/// A short confirmation at the bottom, cleared after a moment.
struct SettingsToast: View {
    @Binding var text: String?

    var body: some View {
        if let text {
            Text(text)
                .font(Tokens.Typography.supporting.font)
                .foregroundStyle(Tokens.Interaction.actionForeground.color)
                .padding(.horizontal, Tokens.Space.inset)
                .padding(.vertical, Tokens.Space.medium)
                .background(Tokens.Interaction.actionFill.color, in: .capsule)
                .padding(.bottom, Tokens.Space.section)
                .accessibilityIdentifier("settings.toast")
                .task {
                    try? await Task.sleep(for: .seconds(3))
                    self.text = nil
                }
        }
    }
}
