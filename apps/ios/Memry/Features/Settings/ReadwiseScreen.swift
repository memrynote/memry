import MemryCore
import SwiftUI

// #3477, D18. Settings › Readwise, read-only. One desktop pulls from Readwise
// (D13) and writes its status into the synced `readwise` group; this screen
// shows what it reports and offers no control. Wording mirrors desktop's
// `notes.readwise.syncsOn`; the rest is new copy for this screen.

enum ReadwiseCopy {
    static let title = "Readwise"
    static let folder = "Folder"
    static let lastChange = "Last change"
    static let status = "Status"
    static let upToDate = "Up to date"
    static let needsAttention = "Needs attention"
    static let noChangeYet = "No changes yet"
    static let notConnected = "Not connected"
    static let errorTitle = "Readwise needs attention"
    static let footer = "Readwise is pulled by one desktop. Change settings or sync from that device."
    static let notConnectedFooter = "Connect Readwise in memry on a desktop. Its notes then arrive here."
    static let anotherDevice = "another device"
    static func syncsOn(_ device: String) -> String { "Syncs on \(device)" }
    static func rejected(_ device: String) -> String {
        "The token on \(device) was rejected. Open memry there and paste a new token."
    }
    static func expired(_ device: String) -> String {
        "The Readwise subscription on \(device) expired. Renew it on readwise.io, then open memry there."
    }
    static func generic(_ device: String) -> String { "Open memry on \(device) to see what Readwise needs." }
}

/// What the screen says, from the core's `ReadwiseStatus` and the account's
/// device list.
struct ReadwiseDisplay: Equatable {
    let connected: Bool
    let device: String
    let folder: String
    let lastChange: Date?
    /// The sentence under "Readwise needs attention", or `nil` when healthy.
    let problem: String?

    init(_ status: ReadwiseStatus, devices: [AccountDevice]) {
        connected = status.connected
        let name = devices.first { $0.id == status.deviceId }?.name
            ?? status.deviceName ?? ReadwiseCopy.anotherDevice
        device = name
        folder = status.rootFolder
        lastChange = status.lastChangeAt.flatMap(Self.date)
        problem = status.error.map { code in
            switch code {
            case "invalid-token": ReadwiseCopy.rejected(name)
            case "subscription-expired": ReadwiseCopy.expired(name)
            default: ReadwiseCopy.generic(name)
            }
        }
    }

    /// The row's value on the Settings root.
    var summary: String {
        guard connected else { return ReadwiseCopy.notConnected }
        return problem == nil ? ReadwiseCopy.upToDate : ReadwiseCopy.needsAttention
    }

    /// `Today, 12:04`, `Yesterday, 18:40`, or the date and time.
    static func when(_ date: Date, now: Date = .now, calendar: Calendar = .current) -> String {
        let time = date.formatted(date: .omitted, time: .shortened)
        if calendar.isDate(date, inSameDayAs: now) { return "Today, \(time)" }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now),
           calendar.isDate(date, inSameDayAs: yesterday) { return "Yesterday, \(time)" }
        return date.formatted(date: .abbreviated, time: .shortened)
    }

    private static func date(_ iso: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
    }
}

struct ReadwiseScreen: View {
    let context: SettingsContext

    var body: some View {
        let display = context.store.readwise.map { ReadwiseDisplay($0, devices: context.account.devices) }
        List {
            if let display, display.connected {
                if let problem = display.problem { Section { ErrorCard(text: problem) } }
                Section {
                    SettingsRowLabel(title: ReadwiseCopy.syncsOn(display.device))
                    SettingsRowLabel(title: ReadwiseCopy.folder, value: display.folder)
                    SettingsRowLabel(
                        title: ReadwiseCopy.lastChange,
                        value: display.lastChange.map { ReadwiseDisplay.when($0) } ?? ReadwiseCopy.noChangeYet
                    )
                    statusRow(failing: display.problem != nil)
                } footer: {
                    SettingsFooter(ReadwiseCopy.footer)
                }
            } else if display != nil {
                Section {
                    SettingsRowLabel(title: ReadwiseCopy.status, value: ReadwiseCopy.notConnected)
                } footer: {
                    SettingsFooter(ReadwiseCopy.notConnectedFooter)
                }
            }
        }
        .settingsList()
        .navigationTitle(ReadwiseCopy.title)
        .accessibilityIdentifier("settings.readwise")
        .task { await context.account.loadDevices() }
        .refreshable {
            await context.tasks.sync()
            await context.store.refreshIfChanged()
        }
    }

    private func statusRow(failing: Bool) -> some View {
        HStack(spacing: Tokens.Space.medium) {
            Text(ReadwiseCopy.status)
                .font(Tokens.Typography.body.font)
                .foregroundStyle(Tokens.Text.primary.color)
            Spacer(minLength: Tokens.Space.small)
            Text(failing ? ReadwiseCopy.needsAttention : ReadwiseCopy.upToDate)
                .font(Tokens.Typography.body.font)
        }
        .foregroundStyle(failing ? Tokens.Interaction.destructive.color : Tokens.Task.complete.color)
        .frame(minHeight: Tokens.Size.minimumHitArea)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("settings.readwise.status")
    }
}

/// The error card: the icon and the words carry the state, not the colour alone.
private struct ErrorCard: View {
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.small) {
            Label(ReadwiseCopy.errorTitle, systemImage: "exclamationmark.triangle")
                .font(Tokens.Typography.heading.font)
                .foregroundStyle(Tokens.Interaction.destructive.color)
            Text(text)
                .font(Tokens.Typography.supporting.font)
                .foregroundStyle(Tokens.Text.secondary.color)
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("settings.readwise.error")
        .listRowBackground(Tokens.Interaction.destructive.color.opacity(Tokens.Palette.chipFillAlpha))
    }
}
