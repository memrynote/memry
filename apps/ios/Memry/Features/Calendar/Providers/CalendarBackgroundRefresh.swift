import BackgroundTasks
import Foundation

// Spec 007 CL075. Google and CalDAV are polled (desktop's CalDAV interval is
// 15 minutes; Google's push relay reaches only devices with a realtime socket,
// which this shell does not open). While the app is suspended, iOS may wake it
// on `com.memry.app.sync.refresh` (already permitted in Info.plist): one sync
// pass — records, then this device's provider pushes and due pulls, then due
// subscribed feeds. The foreground, pull to refresh and each provider
// screen's Sync now run the same pass.

@MainActor
final class CalendarBackgroundRefresh {
    static let shared = CalendarBackgroundRefresh()
    nonisolated static let identifier = "com.memry.app.sync.refresh"

    /// The open vault's calendar; nil until a vault opens this launch.
    weak var store: CalendarStore?

    /// Before launch finishes (`BGTaskScheduler` rejects later registrations).
    nonisolated static func register() {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: identifier, using: .main) { task in
            // Delivered on the main queue (`using: .main`); the task object is
            // only touched there.
            nonisolated(unsafe) let refresh = task as? BGAppRefreshTask
            MainActor.assumeIsolated {
                if let refresh { shared.run(refresh) }
            }
        }
    }

    /// Asks for the next wake; iOS decides when (not before 15 minutes).
    func schedule() {
        let request = BGAppRefreshTaskRequest(identifier: Self.identifier)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        do {
            try BGTaskScheduler.shared.submit(request)
        } catch {
            Log.sync.notice("a background calendar refresh could not be scheduled", .code("calendar.bg.schedule"))
        }
    }

    private func run(_ task: BGAppRefreshTask) {
        schedule()
        guard let store else {
            task.setTaskCompleted(success: true)
            return
        }
        Self.drive(task) {
            await store.sync(forceProviders: false)
            _ = await store.refreshFeeds()
        }
    }

    /// Runs `pass` for `task` and completes the task once: when the pass
    /// ends, or at expiry, whichever comes first. A cancel does not stop the
    /// pass's network round trips, and iOS may kill an app whose task is
    /// still open when its time runs out (`BGTask.setTaskCompleted`).
    @discardableResult
    static func drive(_ task: BackgroundTaskRun, pass: @escaping @MainActor () async -> Void) -> Task<Void, Never> {
        var completed = false
        let complete = { (success: Bool) in
            guard !completed else { return }
            completed = true
            task.setTaskCompleted(success: success)
        }
        let work = Task { @MainActor in
            await pass()
            complete(!Task.isCancelled)
        }
        task.expirationHandler = {
            Task { @MainActor in
                work.cancel()
                complete(false)
            }
        }
        return work
    }
}
