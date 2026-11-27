import Foundation
import Synchronization
import Testing

@testable import Memry

// #2864: a recognition resumes its caller exactly once and holds its task
// until then, even when the recognizer never calls back.

private final class FakeTask: InboxRecognitionTask, Sendable {
    let cancels = Atomic<Int>(0)
    func cancel() { cancels.add(1, ordering: .relaxed) }
}

@Suite("Inbox transcriber")
struct InboxTranscriberTests {
    @Test("a recognizer that never calls back times out to nil and cancels its task")
    func silentRecognizerTimesOut() async {
        let task = FakeTask()
        let text = await InboxTranscriber.recognize(timeout: .milliseconds(50)) { _ in task }
        #expect(text == nil)
        #expect(task.cancels.load(ordering: .relaxed) == 1)
    }

    @Test("the first result wins; later callbacks and the timeout are ignored")
    func firstResultWins() async {
        let task = FakeTask()
        let text = await InboxTranscriber.recognize(timeout: .milliseconds(50)) { finish in
            finish("[agent] first")
            finish("[agent] second")
            finish(nil)
            return task
        }
        #expect(text == "[agent] first")
        try? await Task.sleep(for: .milliseconds(100))
        #expect(task.cancels.load(ordering: .relaxed) == 1)
    }

    /// The result comes from a thread of its own after `recognize` returned
    /// to wait. A global-queue block raced a 30 s timeout and lost on a
    /// loaded CI runner, where the queue ran nothing for that long (#5484).
    /// The timeout is not under test here, so it is out of reach.
    @Test("a result delivered later on another queue resumes the caller")
    func asyncResult() async {
        let task = FakeTask()
        let text = await InboxTranscriber.recognize(timeout: .seconds(3600)) { finish in
            let recognizer = Thread { finish("[agent] late") }
            recognizer.qualityOfService = .userInitiated
            recognizer.start()
            return task
        }
        #expect(text == "[agent] late")
    }

    @Test("cancelling the caller resumes it with nil")
    func cancellation() async {
        let task = FakeTask()
        let waiting = Task { await InboxTranscriber.recognize(timeout: .seconds(30)) { _ in task } }
        try? await Task.sleep(for: .milliseconds(50))
        waiting.cancel()
        #expect(await waiting.value == nil)
        #expect(task.cancels.load(ordering: .relaxed) == 1)
    }
}
