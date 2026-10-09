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

    @Test("a result delivered later on another queue resumes the caller")
    func asyncResult() async {
        let task = FakeTask()
        let text = await InboxTranscriber.recognize(timeout: .seconds(30)) { finish in
            DispatchQueue.global().asyncAfter(deadline: .now() + 0.05) { finish("[agent] late") }
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
