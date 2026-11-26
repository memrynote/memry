import Foundation
import MemryCore
import Network
import os
import Synchronization
import Testing

@testable import Memry

// T145, the realtime half.
//
// **What is real and what is substituted.** These tests drive a real
// `URLSessionWebSocketTask` against a real WebSocket server — an `NWListener`
// on **127.0.0.1**, which is a loopback pair and not a network call; nothing
// leaves the machine and no staging host is contacted (spec-defect 93). So the
// handshake, the framing, the opcodes and the close are the platform's, not a
// stand-in. What is substituted is the `SocketListener`: the core implements
// that in Rust, and `RecordingListener` stands in for Rust's `Bridge` so a test
// can read what the seam said.
//
// **Nothing here drains a fixed number of callbacks.** Spec-defect 99: a test
// that waits for N elements *hangs* when the bug is a missing call, and twenty
// minutes of silence looks exactly like a deadlock in the seam under test.
// A wait on what the server or the listener recorded awaits their `Changes`,
// bounded by the suite's time limit, because a loaded runner delivered
// callbacks later than any short deadline allowed (#5484). Other waits are
// `settle(until:)`, which **returns false** at its deadline so the assertion
// fails with a message. Every assertion then compares the **whole** recorded
// history rather than its length.

/// A WebSocket server on loopback, and a record of what reached it.
final class LoopbackSocketServer: @unchecked Sendable {
    struct Log {
        var connections = 0
        var closes = 0
        var textFrames: [String] = []
        var binaryFrames: [Data] = []
    }

    private let listener: NWListener
    private let connections = Mutex<[NWConnection]>([])
    let log = Mutex(Log())
    /// Wakes the tests waiting on `log`.
    let changes = Changes()
    private(set) var port: UInt16 = 0

    init() async throws {
        let options = NWProtocolWebSocket.Options()
        options.autoReplyPing = true
        let parameters = NWParameters.tcp
        parameters.allowLocalEndpointReuse = true
        parameters.defaultProtocolStack.applicationProtocols.insert(options, at: 0)

        listener = try NWListener(using: parameters, on: .any)
        listener.newConnectionHandler = { [weak self] connection in
            guard let self else { return }
            connections.withLock { $0.append(connection) }
            record { $0.connections += 1 }
            connection.start(queue: .global())
            receive(on: connection)
        }
        port = try await Self.start(listener)
    }

    /// Starts the listener and awaits its bind. The old bound was a semaphore
    /// wait in a synchronous init: up to 20 s of a cooperative-pool thread,
    /// on the very runners where the full parallel run starves that pool, and
    /// it still timed out there (#5484). Awaiting holds no thread. A listener
    /// that fails says why, and one that never binds runs into the suite's
    /// time limit, whose cancellation cancels it.
    private static func start(_ listener: NWListener) async throws -> UInt16 {
        let pending = OSAllocatedUnfairLock<CheckedContinuation<UInt16, any Error>?>(initialState: nil)
        let finish: @Sendable (Result<UInt16, any Error>) -> Void = { result in
            pending.withLock { continuation in
                defer { continuation = nil }
                return continuation
            }?.resume(with: result)
        }
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                pending.withLock { $0 = continuation }
                listener.stateUpdateHandler = { state in
                    switch state {
                    case .ready:
                        if let port = listener.port {
                            finish(.success(port.rawValue))
                        } else {
                            finish(.failure(TransportError.Failed(what: "the loopback listener is ready with no port")))
                        }
                    case let .failed(error):
                        finish(.failure(TransportError.Failed(what: "the loopback listener failed: \(error)")))
                    case .cancelled:
                        finish(.failure(TransportError.Failed(what: "the loopback listener never became ready")))
                    default:
                        break
                    }
                }
                listener.start(queue: .global())
            }
        } onCancel: {
            listener.cancel()
        }
    }

    func stop() {
        connections.withLock { open in
            for connection in open { connection.cancel() }
            open = []
        }
        listener.cancel()
    }

    /// The listener has let go of its port.
    var isStopped: Bool {
        if case .cancelled = listener.state { return true }
        return false
    }

    func url(path: String = "/sync/ws") -> String { "ws://127.0.0.1:\(port)\(path)" }

    /// Sends one frame to the first connection, as a real text frame.
    func sendText(_ text: String) {
        guard let connection = connections.withLock({ $0.first }) else { return }
        let metadata = NWProtocolWebSocket.Metadata(opcode: .text)
        let context = NWConnection.ContentContext(identifier: "text", metadata: [metadata])
        connection.send(
            content: Data(text.utf8),
            contentContext: context,
            isComplete: true,
            completion: .contentProcessed { _ in }
        )
    }

    private func record(_ change: (inout Log) -> Void) {
        log.withLock { change(&$0) }
        changes.changed()
    }

    private func receive(on connection: NWConnection) {
        connection.receiveMessage { [weak self] content, context, _, error in
            guard let self else { return }
            let metadata = context?.protocolMetadata(definition: NWProtocolWebSocket.definition)
            let opcode = (metadata as? NWProtocolWebSocket.Metadata)?.opcode
            switch opcode {
            case .text:
                let text = content.flatMap { String(data: $0, encoding: .utf8) } ?? ""
                record { $0.textFrames.append(text) }
            case .binary:
                record { $0.binaryFrames.append(content ?? Data()) }
            case .close:
                record { $0.closes += 1 }
                return
            default:
                break
            }
            guard error == nil else {
                record { $0.closes += 1 }
                return
            }
            receive(on: connection)
        }
    }
}

/// Stands in for the core's Rust `Bridge`. Records, and reads nothing.
final class RecordingListener: SocketListener, @unchecked Sendable {
    enum Event: Equatable, Sendable {
        case open
        case message(Data)
        case closed(UInt16)
        case failed(TransportErrorKind)
    }

    let events = Mutex<[Event]>([])
    private let changes = Changes()

    var history: [Event] { events.withLock { $0 } }

    /// The whole history once it holds at least `count` events. No deadline:
    /// the suite's time limit bounds it, because a loaded runner delivered
    /// callbacks later than the old 5 s poll allowed (#5484).
    func history(after count: Int) async -> [Event] {
        await changes.until { history.count >= count }
        return history
    }

    func onOpen() { record(.open) }
    func onMessage(payload: Data) { record(.message(payload)) }
    func onClosed(code: UInt16, reason: String) { record(.closed(code)) }
    func onError(error: TransportError) { record(.failed(TransportErrorKind(error))) }

    private func record(_ event: Event) {
        events.withLock { $0.append(event) }
        changes.changed()
    }
}

/// Polls a condition to a deadline and **fails** there rather than waiting
/// forever. See the note at the top of this file.
private func settle(
    timeout: Duration = .seconds(5),
    until condition: @Sendable () -> Bool
) async -> Bool {
    let deadline = ContinuousClock.now + timeout
    while ContinuousClock.now < deadline {
        if condition() { return true }
        try? await Task.sleep(for: .milliseconds(25))
    }
    return condition()
}

@Suite("Transport realtime socket", .serialized, .timeLimit(.minutes(1)))
struct TransportSocketTests {
    private let hub = CoreEvents()

    private func transport() -> URLSessionTransport {
        URLSessionTransport(emitter: hub.emitter)
    }

    private func socketRequest(_ server: LoopbackSocketServer) -> SocketRequest {
        SocketRequest(
            url: server.url(),
            headers: ["authorization": "Bearer test", "x-app-version": "1.2.3", "x-memry-vault-id": "vault-a"]
        )
    }

    /// Open, one frame in, one close out — as one history rather than as three
    /// counts. The payload is compared byte for byte because the socket is
    /// never a data path: the seam must carry the frame and read none of it.
    @Test("a frame arrives as bytes, unparsed, between an open and a close")
    func deliversFramesWithoutReadingThem() async throws {
        let server = try await LoopbackSocketServer()
        defer { server.stop() }
        let listener = RecordingListener()
        let subject = transport()

        let handle = try subject.openSocket(request: socketRequest(server), listener: listener)
        #expect(await listener.history(after: 1) == [.open])

        let frame = #"{"type":"changes_available","payload":{"cursor":"c1"}}"#
        server.sendText(frame)
        #expect(await listener.history(after: 2).count == 2)

        handle.close()
        #expect(await listener.history(after: 3).count == 3)

        let history = listener.history
        #expect(history.prefix(2) == [.open, .message(Data(frame.utf8))])
        #expect(history.count == 3)
        if case let .closed(code) = history[2] {
            #expect(code == 1000)
        } else {
            Issue.record("the socket ended as \(history[2]) rather than a close")
        }
    }

    /// Chapter 09 §9.6: the keepalive must be exactly the text frame `ping`,
    /// because Cloudflare's request-response pair answers that one payload
    /// without waking the Durable Object or spending the socket's rate-limit
    /// budget. The seam carries bytes and no opcode, so a binary frame here
    /// would be a real protocol divergence that nothing else catches.
    @Test("the core's keepalive bytes go out as a text frame")
    func keepaliveIsATextFrame() async throws {
        let server = try await LoopbackSocketServer()
        defer { server.stop() }
        let listener = RecordingListener()
        let subject = transport()

        let handle = try subject.openSocket(request: socketRequest(server), listener: listener)
        #expect(await listener.history(after: 1) == [.open])

        try handle.send(payload: Data("ping".utf8))

        await server.changes.until { !server.log.withLock { $0.textFrames.isEmpty } }
        #expect(server.log.withLock { $0.textFrames } == ["ping"])
        #expect(server.log.withLock { $0.binaryFrames.isEmpty })
        withExtendedLifetime(handle) {}
    }

    /// The lifetime rule: the core holds the handle for the socket's lifetime,
    /// and dropping it closes the socket. Proven from the server's side, which
    /// is the only place a close is a fact rather than a claim.
    @Test("dropping the handle closes the socket")
    func droppingTheHandleClosesTheSocket() async throws {
        let server = try await LoopbackSocketServer()
        defer { server.stop() }
        let listener = RecordingListener()
        let subject = transport()

        var handle: SocketHandle? = try subject.openSocket(request: socketRequest(server), listener: listener)
        #expect(await listener.history(after: 1) == [.open])
        #expect(server.log.withLock { $0.closes } == 0)

        handle = nil
        #expect(handle == nil)

        await server.changes.until { server.log.withLock { $0.closes } >= 1 }
        #expect(server.log.withLock { $0.closes } == 1)
    }

    /// Chapter 09 §9.1: a client MUST close the socket when backgrounded. The
    /// reopen is `RealtimeClient::connect()`'s, because a handshake carries a
    /// bearer token this seam must never mint or reuse — so returning to the
    /// foreground must leave the socket closed and the core informed, not
    /// reopen behind the core's back and race its ladder into a second socket.
    @Test("background closes the socket and foreground does not reopen it")
    func backgroundClosesAndForegroundDoesNotReopen() async throws {
        let server = try await LoopbackSocketServer()
        defer { server.stop() }
        let listener = RecordingListener()
        let subject = transport()

        let handle = try subject.openSocket(request: socketRequest(server), listener: listener)
        #expect(await listener.history(after: 1) == [.open])

        subject.phaseChanged(to: .background)
        #expect(await listener.history(after: 2) == [.open, .closed(URLSessionTransport.backgroundCloseCode)])

        subject.phaseChanged(to: .foreground)
        // Nothing new may appear: no second open here, no second connection at
        // the server. A reopen would show up as either. `phaseChanged` starts
        // any reopen before it returns, so the probe opened after it usually
        // reaches the server behind that reopen. Nothing orders two
        // connections at the server, so this is best effort, as the fixed
        // sleep it replaced was: a reopen that lands after the probe goes
        // unseen here.
        let probe = RecordingListener()
        let probeHandle = try subject.openSocket(request: socketRequest(server), listener: probe)
        #expect(await probe.history(after: 1) == [.open])
        await server.changes.until { server.log.withLock { $0.connections } >= 2 }
        #expect(listener.history == [.open, .closed(URLSessionTransport.backgroundCloseCode)])
        #expect(server.log.withLock { $0.connections } == 2, "only the probe connected")
        withExtendedLifetime((handle, probeHandle)) {}
    }

    /// A write to a socket that is already closed fails **now**, with a typed
    /// error, rather than being queued into a socket that will never send it.
    @Test("a send after the close reports the socket closed")
    func sendAfterCloseFails() async throws {
        let server = try await LoopbackSocketServer()
        defer { server.stop() }
        let listener = RecordingListener()
        let subject = transport()

        let handle = try subject.openSocket(request: socketRequest(server), listener: listener)
        #expect(await listener.history(after: 1) == [.open])
        handle.close()
        #expect(await listener.history(after: 2).count == 2)

        var thrown: TransportErrorKind?
        do {
            try handle.send(payload: Data("ping".utf8))
        } catch {
            thrown = TransportErrorKind(error)
        }
        #expect(thrown == .socketClosed)
    }

    /// `open_socket` is synchronous on purpose: readiness is `on_open` and
    /// failure is `on_error`. So a handshake to a dead port still returns a
    /// handle, and the failure arrives later — and it is never reported inline,
    /// because this method is called from Rust.
    @Test("a handshake that fails reports on_error rather than throwing")
    func failedHandshakeReportsOnError() async throws {
        let server = try await LoopbackSocketServer()
        let deadPort = server.port
        server.stop()
        #expect(await settle { server.isStopped }, "the listener never released the port")

        let listener = RecordingListener()
        let subject = transport()
        let request = SocketRequest(url: "ws://127.0.0.1:\(deadPort)/sync/ws", headers: [:])

        let handle = try subject.openSocket(request: request, listener: listener)
        #expect(listener.history.isEmpty)

        #expect(await listener.history(after: 1).count == 1)
        let history = listener.history
        #expect(history.first != .open)
        if case .failed = history.first {
            // The variant is the mapping's business and is asserted in
            // `TransportTests`; what matters here is that the failure came back
            // as an error report and not as an open.
        } else {
            Issue.record("a dead port produced \(String(describing: history.first))")
        }
        withExtendedLifetime(handle) {}
    }

    /// #2872: a handshake the server refuses with an HTTP status reaches the
    /// core as that status, because §9.10 forbids reconnecting into 401, 403
    /// and 426 and the core can only tell them apart by it.
    @Test("a refused handshake reports its HTTP status")
    func refusedHandshakeReportsStatus() async throws {
        let server = try NWListener(using: .tcp, on: .any)
        server.newConnectionHandler = { connection in
            connection.start(queue: .global())
            connection.receive(minimumIncompleteLength: 1, maximumLength: 4096) { _, _, _, _ in
                let answer = "HTTP/1.1 426 Upgrade Required\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
                connection.send(content: Data(answer.utf8), completion: .contentProcessed { _ in connection.cancel() })
            }
        }
        server.start(queue: .global())
        defer { server.cancel() }
        #expect(await settle { (server.port?.rawValue ?? 0) != 0 })
        let port = try #require(server.port?.rawValue)

        let statuses = Mutex<[UInt16]>([])
        final class StatusListener: SocketListener, @unchecked Sendable {
            let record: @Sendable (UInt16) -> Void
            init(record: @escaping @Sendable (UInt16) -> Void) { self.record = record }
            func onOpen() { record(101) }
            func onMessage(payload: Data) {}
            func onClosed(code: UInt16, reason: String) { record(code) }
            func onError(error: TransportError) {
                if case let .HandshakeRejected(status) = error { record(status) } else { record(0) }
            }
        }
        let listener = StatusListener { status in statuses.withLock { $0.append(status) } }
        let subject = transport()
        let handle = try subject.openSocket(
            request: SocketRequest(url: "ws://127.0.0.1:\(port)/sync/ws", headers: [:]),
            listener: listener
        )
        #expect(await settle { !statuses.withLock { $0.isEmpty } })
        #expect(statuses.withLock { $0 } == [426])
        withExtendedLifetime((subject, handle)) {}
    }
}
