import Foundation
import MemryCore
import UserNotifications

// IB23 (D8). The inbox's two local notifications, counts only (no capture
// text: iOS keeps notification text in plaintext outside the vault, spec 002
// R12, apps/ios/AGENTS.md):
//
// * the daily review nudge (desktop `review-scheduler.ts`): at the synced
//   `reviewReminderTime`, when enabled and captures are waiting;
// * snooze-due (desktop `SNOOZE_DUE`): when snoozed captures come back,
//   one notification per minute they return in, carrying the count.
//
// Desktop decides at fire time on a minute tick; iOS cannot run then, so the
// requests are rebuilt from the current counts on every inbox refresh and
// foreground: the nudge for its next time with today's count (none when the
// inbox is empty), the nearest three snooze returns. Task reminders keep
// their 60-request window; the inbox takes at most four of the 64 (§6 IB23).
// A tap opens the Inbox (`InboxLinks`).

enum InboxNotificationIds {
    static let prefix = "memry.inbox."
    static let review = prefix + "review"
    static let test = prefix + "test"
    static let snoozePrefix = prefix + "snooze."
    /// `userInfo` key the notification delegate routes to the Inbox.
    static let routeKey = "memry.inbox"
}

@MainActor
enum InboxNotifications {
    static let snoozeWindow = 3

    /// Rebuilds the inbox's pending requests from the store's state.
    static func refresh(store: InboxStore) async {
        let center = UNUserNotificationCenter.current()
        guard await center.notificationSettings().authorizationStatus == .authorized else { return }
        let pending = await center.pendingNotificationRequests().map(\.identifier)
            .filter { $0.hasPrefix(InboxNotificationIds.prefix) && $0 != InboxNotificationIds.test }
        center.removePendingNotificationRequests(withIdentifiers: pending)
        let now = store.clock()
        if let settings = await store.read({ try $0.reviewSettings() }), settings.enabled,
           let count = store.stats?.reviewable, count > 0,
           let fire = nextFire(settings.time, now: now) {
            add(center, InboxNotificationIds.review, InboxCopy.reviewTitle(Int(count)), InboxCopy.reviewBody, at: fire)
        }
        let snoozed = await store.read { try $0.snoozed() } ?? []
        let byMinute = Dictionary(grouping: snoozed.compactMap(\.snoozedUntilMs).filter { $0 > store.nowMs }) { $0 / 60_000 }
        for minute in byMinute.keys.sorted().prefix(snoozeWindow) {
            let count = byMinute[minute]?.count ?? 0
            add(center, InboxNotificationIds.snoozePrefix + String(minute), InboxCopy.snoozeDueTitle(count),
                InboxCopy.snoozeDueBody(count), at: Date(timeIntervalSince1970: TimeInterval(minute * 60)))
        }
    }

    /// Settings › Send test notification (desktop's `testBody`).
    static func sendTest() async -> Bool {
        let center = UNUserNotificationCenter.current()
        guard await authorize() else { return false }
        add(center, InboxNotificationIds.test, InboxCopy.reviewTestTitle, InboxCopy.reviewTestBody,
            at: Date().addingTimeInterval(2))
        return true
    }

    /// Asks once, when the user turns the reminder on or sends a test.
    static func authorize() async -> Bool {
        let center = UNUserNotificationCenter.current()
        switch await center.notificationSettings().authorizationStatus {
        case .authorized, .provisional: return true
        case .notDetermined: return (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
        default: return false
        }
    }

    /// Drops everything the inbox scheduled (the vault closed).
    static func clearAll() async {
        let center = UNUserNotificationCenter.current()
        let ours = await center.pendingNotificationRequests().map(\.identifier)
            .filter { $0.hasPrefix(InboxNotificationIds.prefix) }
        center.removePendingNotificationRequests(withIdentifiers: ours)
    }

    /// The next `HH:MM` at or after now (today if still ahead, else tomorrow).
    nonisolated static func nextFire(_ time: String, now: Date, calendar: Calendar = .current) -> Date? {
        let parts = time.split(separator: ":").compactMap { Int($0) }
        guard parts.count == 2,
              let today = calendar.date(bySettingHour: parts[0], minute: parts[1], second: 0, of: now)
        else { return nil }
        return today > now ? today : calendar.date(byAdding: .day, value: 1, to: today)
    }

    private static func add(_ center: UNUserNotificationCenter, _ id: String, _ title: String, _ body: String, at date: Date) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        content.userInfo = [InboxNotificationIds.routeKey: "1"]
        let components = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute, .second], from: date)
        let trigger = UNCalendarNotificationTrigger(dateMatching: components, repeats: false)
        center.add(UNNotificationRequest(identifier: id, content: content, trigger: trigger))
    }
}
