import MemryCore
import SwiftUI
import UIKit
import UserNotifications

// Spec 006 ST52, artboards 18 / 18a / 18b / 18c and flow lane 05. Image
// filing is this iPhone's; the review reminder (on/off, time) is synced (F2)
// and each device schedules its own daily local notification from it.
// Behind the Inbox gate (F9).
struct InboxSettingsScreen: View {
    let context: SettingsContext
    @State private var local = LocalSettings.shared
    @State private var authorization: UNAuthorizationStatus = .notDetermined
    @State private var notice: String?
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        List {
            Section {
                Picker(InboxCopy.filing, selection: $local.imageFiling) {
                    Text(InboxCopy.embed).tag(ImageFiling.embed)
                    Text(InboxCopy.link).tag(ImageFiling.link)
                }
                .pickerStyle(.menu)
                .accessibilityIdentifier("settings.inbox.filing")
                SettingsToggleRow(title: InboxCopy.ask, isOn: $local.askEveryTime, identifier: "settings.inbox.ask")
            } header: {
                Text(InboxCopy.images)
            } footer: {
                SettingsFooter(InboxCopy.filingFooter)
            }
            Section {
                if authorization == .denied {
                    VStack(alignment: .leading, spacing: Tokens.Space.small) {
                        Text(InboxCopy.deniedTitle).font(Tokens.Typography.heading.font)
                        Text(InboxCopy.deniedBody)
                            .font(Tokens.Typography.supporting.font)
                            .foregroundStyle(Tokens.Text.secondary.color)
                        Button(InboxCopy.openSettings) {
                            if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                        }
                        .accessibilityIdentifier("settings.inbox.openSettings")
                    }
                }
                SettingsToggleRow(title: InboxCopy.remind, isOn: enabled, identifier: "settings.inbox.remind")
                    .disabled(authorization == .denied)
                DatePicker(InboxCopy.time, selection: time, displayedComponents: .hourAndMinute)
                    .datePickerStyle(.compact)
                    .disabled(!context.store.review.enabled || authorization == .denied)
                    .accessibilityIdentifier("settings.inbox.time")
                if context.store.review.enabled, authorization != .denied {
                    SettingsActionRow(title: InboxCopy.test, symbol: "bell", identifier: "settings.inbox.test") {
                        Task {
                            await ReviewReminder.sendTest()
                            notice = InboxCopy.testSent
                        }
                    }
                }
            } header: {
                Text(InboxCopy.reviewGroup)
            } footer: {
                SettingsFooter(InboxCopy.reviewFooter)
            }
        }
        .settingsList()
        .navigationTitle(SettingsCopy.inbox)
        .navigationBarTitleDisplayMode(.inline)
        .overlay(alignment: .bottom) { SettingsToast(text: $notice) }
        .task { authorization = await ReviewReminder.status() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { authorization = await ReviewReminder.status() } }
        }
    }

    private var enabled: Binding<Bool> {
        Binding(get: { context.store.review.enabled }, set: { on in
            Task {
                if on, authorization == .notDetermined {
                    authorization = await ReviewReminder.requestAuthorization()
                    guard authorization != .denied else { return }
                }
                await context.store.setReviewReminder(enabled: on, time: context.store.review.time)
                await ReviewReminder.reschedule(context.store.review)
            }
        })
    }

    private var time: Binding<Date> {
        Binding(get: { ReviewReminder.date(context.store.review.time) }, set: { date in
            let value = ReviewReminder.text(date)
            Task {
                await context.store.setReviewReminder(enabled: context.store.review.enabled, time: value)
                await ReviewReminder.reschedule(context.store.review)
            }
        })
    }
}

/// The one repeating local notification. The text never names inbox content
/// (apps/ios AGENTS.md: notification text is stored outside the vault).
enum ReviewReminder {
    static let identifier = "inbox.review.daily"

    static func status() async -> UNAuthorizationStatus {
        await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
    }

    static func requestAuthorization() async -> UNAuthorizationStatus {
        _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])
        return await status()
    }

    /// Applies the synced setting on this device: one daily trigger, or none.
    static func reschedule(_ review: ReviewReminderSettings) async {
        let center = UNUserNotificationCenter.current()
        center.removePendingNotificationRequests(withIdentifiers: [identifier])
        guard review.enabled, SettingsFeatureGates.inbox, await status() == .authorized else { return }
        let parts = review.time.split(separator: ":").compactMap { Int($0) }
        guard parts.count == 2 else { return }
        let trigger = UNCalendarNotificationTrigger(
            dateMatching: DateComponents(hour: parts[0], minute: parts[1]), repeats: true
        )
        try? await center.add(UNNotificationRequest(identifier: identifier, content: content(), trigger: trigger))
    }

    static func sendTest() async {
        let trigger = UNTimeIntervalNotificationTrigger(timeInterval: 1, repeats: false)
        try? await UNUserNotificationCenter.current()
            .add(UNNotificationRequest(identifier: identifier + ".test", content: content(), trigger: trigger))
    }

    private static func content() -> UNMutableNotificationContent {
        let content = UNMutableNotificationContent()
        content.title = InboxCopy.notificationTitle
        content.body = InboxCopy.notificationBody
        content.userInfo = ["route": "inbox"]
        return content
    }

    static func date(_ text: String) -> Date {
        let parts = text.split(separator: ":").compactMap { Int($0) }
        let components = DateComponents(hour: parts.first ?? 18, minute: parts.dropFirst().first ?? 0)
        return Calendar.current.date(from: components) ?? .now
    }

    static func text(_ date: Date) -> String {
        let parts = Calendar.current.dateComponents([.hour, .minute], from: date)
        return String(format: "%02d:%02d", parts.hour ?? 18, parts.minute ?? 0)
    }
}

/// Desktop `settings.json` `inbox.*` wording.
enum InboxCopy {
    static let images = "Images"
    static let filing = "Filing an image to a note"
    static let embed = "Embed in the note"
    static let link = "File in the sidebar"
    static let ask = "Ask every time"
    static let filingFooter = "This iPhone. Embed puts the image in the note body. File keeps it as an attachment in the note’s sidebar."
    static let reviewGroup = "Daily review reminder"
    static let remind = "Remind me to review my inbox"
    static let time = "Reminder time"
    static let test = "Send test notification"
    static let testSent = "Test notification sent"
    static let reviewFooter = "Shared with your other devices. Each device reminds you once a day at this time."
    static let deniedTitle = "Notifications are off for memrynote"
    static let deniedBody = "Turn them on in iOS Settings to get the daily review reminder."
    static let openSettings = "Open iOS Settings"
    static let notificationTitle = "Review your inbox"
    static let notificationBody = "Tap to start."
}
