import MemryCore
import Observation
import SwiftUI
import UserNotifications

// TP053, FR-061/062. The two ends of a reminder notification inside the app:
//
// * **Refill** — ``SwiftUI/View/reminderScheduling(store:)`` keeps the
//   pending window current. It works wherever it is attached (the Tasks tab or
//   the vault's tab shell): it refills on appear, on every foreground, after
//   every task write (the store's tasks change) and after every sync pass.
// * **Tap** — the app delegate installs ``ReminderNotificationDelegate``; a
//   tap lands in ``ReminderTaps/shared`` and the vault shell, which owns the
//   ``TasksRouter``, opens the task. A task completed or removed elsewhere
//   still opens its detail, which shows its done state or the "not in this
//   vault" state rather than a ghost.

/// What a tapped reminder notification points at.
struct ReminderTap: Equatable, Sendable {
    let reminderId: String
    let targetType: String
    let targetId: String

    /// Reads a notification's `userInfo`; `nil` for one this app did not make.
    init?(userInfo: [AnyHashable: Any]) {
        guard let targetType = userInfo["targetType"] as? String,
              let targetId = userInfo["targetId"] as? String,
              !targetId.isEmpty else { return nil }
        self.init(reminderId: userInfo["reminderId"] as? String ?? "", targetType: targetType, targetId: targetId)
    }

    init(reminderId: String, targetType: String, targetId: String) {
        self.reminderId = reminderId
        self.targetType = targetType
        self.targetId = targetId
    }

    /// Where a tap goes: a task opens in the Tasks tab; any other target
    /// (note, journal, highlight) selects Notes.
    @MainActor
    func open(in router: TasksRouter) {
        if targetType == "task" {
            router.openTask(targetId)
        } else {
            router.selectedTab = .notes
        }
    }
}

/// The hand-off from the notification delegate to the vault shell. A tap that
/// arrives before a vault is open (cold start) waits here until one is.
@MainActor
@Observable
final class ReminderTaps {
    static let shared = ReminderTaps()

    private(set) var pending: ReminderTap?

    func receive(_ tap: ReminderTap) {
        pending = tap
    }

    /// The waiting tap, once.
    func take() -> ReminderTap? {
        defer { pending = nil }
        return pending
    }
}

/// The app's notification delegate: shows a reminder that fires while Memry is
/// open, and forwards a tap to ``ReminderTaps``.
final class ReminderNotificationDelegate: NSObject, UNUserNotificationCenterDelegate, Sendable {
    static let shared = ReminderNotificationDelegate()

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        guard let tap = ReminderTap(userInfo: response.notification.request.content.userInfo) else { return }
        await MainActor.run { ReminderTaps.shared.receive(tap) }
    }
}

extension View {
    /// Keeps the phone's reminder notifications equal to the nearest window of
    /// this store's vault (FR-062).
    func reminderScheduling(store: TasksStore, scheduler: ReminderScheduler = .shared) -> some View {
        modifier(ReminderScheduling(store: store, scheduler: scheduler))
    }
}

private struct ReminderScheduling: ViewModifier {
    let store: TasksStore
    let scheduler: ReminderScheduler
    @Environment(\.scenePhase) private var scenePhase

    func body(content: Content) -> some View {
        content
            .task { scheduler.scheduleRefill(from: store) }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active { scheduler.scheduleRefill(from: store) }
            }
            .onChange(of: store.ordered) { scheduler.scheduleRefill(from: store) }
            .onChange(of: store.isSyncing) { _, syncing in
                if !syncing { scheduler.scheduleRefill(from: store) }
            }
    }
}
