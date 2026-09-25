import MemryCore
import SwiftUI

// IB23. Settings › Inbox (Paper 23, desktop `settings/inbox-section.tsx`):
// the daily review reminder (on/off and time, synced with desktop through the
// `inbox` settings group), Send test notification, and the device-local image
// filing mode with "Ask when filing".

struct InboxSettingsView: View {
    let store: InboxStore

    @State private var enabled = false
    @State private var time = Date()
    @State private var loaded = false
    @State private var testSent = false
    @State private var testDenied = false
    @AppStorage(InboxPreferences.imageModeKey) private var imageMode = InboxImageMode.embed.rawValue
    @AppStorage(InboxPreferences.imageModeRememberedKey) private var remembered = false

    var body: some View {
        Form {
            Section {
                Toggle(InboxCopy.reviewReminder, isOn: $enabled)
                    .accessibilityIdentifier("inbox.settings.review")
                if enabled {
                    DatePicker(InboxCopy.time, selection: $time, displayedComponents: .hourAndMinute)
                        .accessibilityIdentifier("inbox.settings.time")
                }
                Button(InboxCopy.sendTest) {
                    Task {
                        let sent = await InboxNotifications.sendTest()
                        testSent = sent
                        testDenied = !sent
                    }
                }
                .foregroundStyle(Tokens.Text.tint.color)
                .accessibilityIdentifier("inbox.settings.test")
            } header: {
                Text(InboxCopy.dailyReview)
            } footer: {
                Text(testDenied ? InboxCopy.testDenied : testSent ? InboxCopy.testSent : InboxCopy.reviewFooter)
            }
            Section {
                Picker(InboxCopy.imageLandsAs, selection: $imageMode) {
                    Text(InboxCopy.embedShort).tag(InboxImageMode.embed.rawValue)
                    Text(InboxCopy.imageLink).tag(InboxImageMode.link.rawValue)
                }
                .accessibilityIdentifier("inbox.settings.imageMode")
                Toggle(InboxCopy.askWhenFiling, isOn: Binding(get: { !remembered }, set: { remembered = !$0 }))
                    .accessibilityIdentifier("inbox.settings.ask")
            } header: {
                Text(InboxCopy.images)
            } footer: {
                Text(InboxCopy.imagesFooter)
            }
        }
        .scrollContentBackground(.hidden)
        .background(Tokens.Canvas.surface.color)
        .navigationTitle(InboxCopy.title)
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .onChange(of: enabled) { _, _ in save() }
        .onChange(of: time) { _, _ in save() }
    }

    private func load() async {
        guard let settings = await store.read({ try $0.reviewSettings() }) else { return }
        enabled = settings.enabled
        if let date = InboxNotifications.nextFire(settings.time, now: Date()) { time = date }
        loaded = true
    }

    private func save() {
        guard loaded else { return }
        let value = InboxReviewSettings(
            enabled: enabled,
            time: time.formatted(.dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits))
        )
        Task {
            if value.enabled { _ = await InboxNotifications.authorize() }
            await store.write { try $0.setReviewSettings(settings: value) }
            await InboxNotifications.refresh(store: store)
        }
    }
}
