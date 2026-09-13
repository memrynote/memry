import Foundation
import Testing

@testable import Memry

// T141. The hub itself; its producers are T143 to T146 and the shell's own
// sources, and nothing wires it yet.
//
// Every drain below is bounded with `prefix(_:)` rather than by waiting for the
// stream to end, so that a bug in `finish()` fails the one test that asserts
// `finish()` instead of hanging every test that merely needs to stop reading.
@Suite("CoreEvents")
struct CoreEventsTests {
    private func drain(_ stream: AsyncStream<CoreEvent>, upTo count: Int) async -> [CoreEvent] {
        var received: [CoreEvent] = []
        for await event in stream.prefix(count) {
            received.append(event)
        }
        return received
    }

    @Test("hints arrive in the order they were emitted, unchanged")
    func deliversEventsInOrder() async {
        let hub = CoreEvents()
        let emitted: [CoreEvent] = [
            CoreEvent(.secureStoreLocked),
            CoreEvent(.reachability),
            CoreEvent(.storage, scope: .vault("vault-a"))
        ]
        for event in emitted {
            hub.emitter.emit(event)
        }

        let stream = hub.consume()
        #expect(stream != nil)
        let received = await drain(stream!, upTo: emitted.count)

        #expect(received == emitted)
    }

    /// The discriminating test for `.bufferingNewest(256)`.
    ///
    /// 300 hints go in before anything reads. Asserting only the count would
    /// pass under `.unbounded` as soon as the drain is bounded, and asserting
    /// only the count and the first element would pass under
    /// `.bufferingOldest(256)`. The identity of *both* ends is what separates
    /// the three: newest-256 gives 44...299, unbounded gives 0...255 (the first
    /// 256 of 300), oldest-256 gives 0...255 as well but has nothing after it.
    @Test("the buffer keeps the newest 256 hints and drops the oldest")
    func dropsTheOldestUnderPressure() async {
        let hub = CoreEvents()
        for index in 0..<300 {
            hub.emitter.emit(CoreEvent(.realtimeSocket, scope: .document("\(index)")))
        }

        let stream = hub.consume()
        #expect(stream != nil)
        let received = await drain(stream!, upTo: 256)

        #expect(received.count == 256)
        #expect(received.first?.scope == .document("44"))
        #expect(received.last?.scope == .document("299"))
        // A pin on the contract's number, not the proof above.
        #expect(CoreEvents.bufferCapacity == 256)
    }

    /// The hub has one consumer. A second caller must be told the stream is
    /// gone, not handed an empty one: an empty stream means "nothing happened",
    /// and a view that got one would look correct and never refresh.
    @Test("the stream is vended once, and absence reads as absence")
    func vendsTheStreamOnce() async {
        let hub = CoreEvents()

        let first = hub.consume()
        let second = hub.consume()

        #expect(first != nil)
        #expect(second == nil)
    }

    /// A seam callback can arrive after sign-out has torn the hub down.
    @Test("hints emitted after finish are dropped, and buffered ones still arrive")
    func ignoresEmitsAfterFinish() async {
        let hub = CoreEvents()
        let beforeFinish = CoreEvent(.capturePermission)
        hub.emitter.emit(beforeFinish)
        hub.finish()
        hub.emitter.emit(CoreEvent(.scenePhase))

        let stream = hub.consume()
        #expect(stream != nil)
        let received = await drain(stream!, upTo: 2)

        #expect(received == [beforeFinish])
    }

    /// What a foreign-trait callback looks like: a thread that is not the main
    /// one, inside a synchronous call the core is waiting on. `emit` must take
    /// the hint and return. Nothing is draining, so an implementation that
    /// waited for a consumer would deadlock this test rather than fail it —
    /// which is itself the signal.
    @Test("an emitter yields from a non-main thread without waiting for a consumer")
    func emitsFromANonMainThread() async {
        let hub = CoreEvents()
        let emitter = hub.emitter
        let queue = DispatchQueue(label: "t141.producer")

        let ranOffTheMainThread = queue.sync { () -> Bool in
            let offMain = !Thread.isMainThread
            for index in 0..<3 {
                emitter.emit(CoreEvent(.reachability, scope: .document("\(index)")))
            }
            return offMain
        }

        #expect(ranOffTheMainThread)
        let stream = hub.consume()
        #expect(stream != nil)
        let received = await drain(stream!, upTo: 3)
        #expect(received.map(\.scope) == [.document("0"), .document("1"), .document("2")])
    }
}
