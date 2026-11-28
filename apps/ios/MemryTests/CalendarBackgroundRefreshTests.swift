import Testing
@testable import Memry

/// A sync pass that runs until the test lets it finish, as a network round
/// trip does after its task is cancelled.
@MainActor
final class HeldPass {
    private var waiting: CheckedContinuation<Void, Never>?
    private(set) var started = false

    func run() async {
        started = true
        await withCheckedContinuation { waiting = $0 }
    }

    func finish() {
        waiting?.resume()
        waiting = nil
    }
}

@MainActor
struct CalendarBackgroundRefreshTests {
    /// iOS may kill an app that has not completed its task when the task's
    /// time runs out (`BGTask.setTaskCompleted`), so expiry completes it
    /// without waiting for the pass.
    @Test(.timeLimit(.minutes(1)))
    func expiryCompletesTheTaskWhileThePassIsStillRunning() async {
        let task = FakeTaskRun()
        let pass = HeldPass()
        let work = CalendarBackgroundRefresh.drive(task) { await pass.run() }
        while !pass.started { await Task.yield() }

        task.expirationHandler?()
        while task.completions.isEmpty { await Task.yield() }
        #expect(task.completions == [false])

        pass.finish()
        await work.value
        #expect(task.completions == [false])
    }

    @Test(.timeLimit(.minutes(1)))
    func aFinishedPassCompletesTheTaskOnce() async {
        let task = FakeTaskRun()
        await CalendarBackgroundRefresh.drive(task) {}.value
        #expect(task.completions == [true])
    }
}
