import Foundation
import MemryCore
import Observation
import UserNotifications

// TP053, FR-061/062. Reminders fire as local notifications from already-synced
// data, with the app closed or offline. Local only: nothing is pushed.
//
// **Which reminders, and when, is the core's** (`dueReminders`): every pending
// or snoozed reminder with its fire time and whether its target still exists
// or is completed. The shell only decides what the platform forces on it:
//
// * iOS holds 64 pending requests per app, so the nearest
//   ``ReminderSchedulePlan/window`` (60) are scheduled and the rest wait;
//   the window refills on every foreground, after each task write, after each
//   sync, and after each reminder edit (see `ReminderNotificationsRouting`).
// * a reminder whose target is gone or completed is not scheduled;
// * a reminder whose time has passed cannot be scheduled (desktop fires it
//   once and marks it `triggered`, a device-local state the core does not
//   export, so an overdue one is left to the task's reminder list).
//
// Permission is asked when the first reminder is added, never at launch.

/// One local notification the scheduler asks for.
struct ReminderNotification: Equatable, Sendable {
    static let identifierPrefix = "memry.reminder."

    let reminderId: String
    let targetType: String
    let targetId: String
    let title: String
    let body: String
    let fireAt: Date

    var identifier: String { Self.identifierPrefix + reminderId }

    /// What a tap hands back to the shell (`ReminderTap`).
    var userInfo: [String: String] {
        ["reminderId": reminderId, "targetType": targetType, "targetId": targetId]
    }
}

/// The nearest window of schedulable reminders (FR-062).
struct ReminderSchedulePlan: Equatable, Sendable {
    /// iOS keeps 64 pending requests per app; four stay free for the system.
    static let window = 60

    let notifications: [ReminderNotification]
    /// Schedulable reminders past the window, waiting for a refill.
    let beyondWindow: Int

    /// - Parameter due: the core's `dueReminders`, earliest first.
    static func make(_ due: [DueReminderItem], now: Date, window: Int = window) -> ReminderSchedulePlan {
        let nowMs = Int64((now.timeIntervalSince1970 * 1000).rounded(.down))
        let eligible = due.filter { $0.targetExists && !$0.targetCompleted && $0.fireAtMs > nowMs }
        let notifications = eligible.prefix(window).map { item in
            ReminderNotification(
                reminderId: item.reminder.id,
                targetType: item.reminder.targetType,
                targetId: item.reminder.targetId,
                title: nonEmpty(item.reminder.title) ?? nonEmpty(item.targetTitle)
                    ?? TasksCopy.reminderNotificationDefault,
                // Never the reminder's note: iOS stores notification text in
                // plaintext outside the vault (spec 002 research R12), so the
                // body stays generic. The title names what the reminder is for.
                body: TasksCopy.reminderNotificationBody(targetType: item.reminder.targetType),
                fireAt: Date(timeIntervalSince1970: TimeInterval(item.fireAtMs) / 1000)
            )
        }
        return ReminderSchedulePlan(notifications: notifications, beyondWindow: max(0, eligible.count - window))
    }

    private static func nonEmpty(_ value: String?) -> String? {
        guard let value, !value.isEmpty else { return nil }
        return value
    }
}

/// Whether this app may alert.
enum ReminderAuthorization: Equatable, Sendable {
    case notDetermined, allowed, denied
}

/// The seam over `UNUserNotificationCenter`, so the scheduler is testable
/// without a permission prompt.
protocol ReminderNotificationCenter: Sendable {
    func authorization() async -> ReminderAuthorization
    func requestAuthorization() async -> Bool
    func pendingIdentifiers() async -> [String]
    func add(_ notifications: [ReminderNotification], now: Date) async
    func removePending(_ identifiers: [String])
    func removeDelivered(_ identifiers: [String])
}

/// The system center.
struct SystemReminderCenter: ReminderNotificationCenter {
    func authorization() async -> ReminderAuthorization {
        switch await UNUserNotificationCenter.current().notificationSettings().authorizationStatus {
        case .notDetermined: .notDetermined
        case .authorized, .provisional, .ephemeral: .allowed
        default: .denied
        }
    }

    func requestAuthorization() async -> Bool {
        do {
            return try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])
        } catch {
            Log.app.error("notification permission request failed")
            return false
        }
    }

    func pendingIdentifiers() async -> [String] {
        await UNUserNotificationCenter.current().pendingNotificationRequests().map(\.identifier)
    }

    func add(_ notifications: [ReminderNotification], now: Date) async {
        var failed = 0
        for notification in notifications {
            let interval = notification.fireAt.timeIntervalSince(now)
            guard interval > 0 else { continue }
            let content = UNMutableNotificationContent()
            content.title = notification.title
            content.body = notification.body
            content.sound = .default
            content.userInfo = notification.userInfo
            content.threadIdentifier = notification.targetType + "." + notification.targetId
            // An absolute interval, not calendar components: the reminder is an
            // instant and must not drift when the phone changes time zone.
            let trigger = UNTimeIntervalNotificationTrigger(timeInterval: interval, repeats: false)
            let request = UNNotificationRequest(identifier: notification.identifier, content: content, trigger: trigger)
            do {
                try await UNUserNotificationCenter.current().add(request)
            } catch {
                failed += 1
            }
        }
        if failed > 0 { Log.app.error("some reminder notifications were not scheduled", .count(failed)) }
    }

    func removePending(_ identifiers: [String]) {
        guard !identifiers.isEmpty else { return }
        UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: identifiers)
    }

    func removeDelivered(_ identifiers: [String]) {
        guard !identifiers.isEmpty else { return }
        UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: identifiers)
    }
}

/// Keeps the phone's pending notifications equal to the nearest window of the
/// open vault's reminders.
@MainActor
@Observable
final class ReminderScheduler {
    static let shared = ReminderScheduler(center: SystemReminderCenter())

    /// Schedulable reminders past the window (the reminders section says so).
    private(set) var beyondWindow = 0
    private(set) var scheduled: [ReminderNotification] = []
    private(set) var authorization: ReminderAuthorization = .notDetermined

    private let center: any ReminderNotificationCenter
    private var pendingRefill: Task<Void, Never>?

    init(center: any ReminderNotificationCenter) {
        self.center = center
    }

    /// Reads the core's due reminders and replaces this app's pending
    /// requests with the nearest window.
    func refill(from store: TasksStore) async {
        authorization = await center.authorization()
        guard let due = await store.read({ try $0.dueReminders(untilMs: nil) }) else { return }
        let now = store.clock()
        let plan = ReminderSchedulePlan.make(due, now: now)
        beyondWindow = plan.beyondWindow
        guard authorization == .allowed else {
            scheduled = []
            return
        }
        let keep = Set(plan.notifications.map(\.identifier))
        let stale = await center.pendingIdentifiers()
            .filter { $0.hasPrefix(ReminderNotification.identifierPrefix) && !keep.contains($0) }
        center.removePending(stale)
        await center.add(plan.notifications, now: now)
        scheduled = plan.notifications
        Log.app.info("reminder window refilled", .count(plan.notifications.count))
    }

    /// A refill a moment from now; calls in quick succession share one.
    func scheduleRefill(from store: TasksStore) {
        pendingRefill?.cancel()
        pendingRefill = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled else { return }
            await self?.refill(from: store)
        }
    }

    /// Asks for permission the first time a reminder is added.
    func requestPermissionIfNeeded() async {
        authorization = await center.authorization()
        guard authorization == .notDetermined else { return }
        authorization = await center.requestAuthorization() ? .allowed : .denied
    }

    /// Pulls one reminder's pending request and delivered banner (dismissed,
    /// snoozed, rescheduled or deleted in the app).
    func forget(reminderId: String) {
        let identifier = ReminderNotification.identifierPrefix + reminderId
        center.removePending([identifier])
        center.removeDelivered([identifier])
    }

    /// Drops every request this app scheduled (the vault closed or the
    /// account signed out), so no reminder text outlives its vault.
    func clearAll() async {
        pendingRefill?.cancel()
        let ours = await center.pendingIdentifiers().filter { $0.hasPrefix(ReminderNotification.identifierPrefix) }
        center.removePending(ours)
        scheduled = []
        beyondWindow = 0
    }
}
