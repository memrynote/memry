import Foundation
import MemryCore
import Network
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
// Every wait below is `settle(until:)`, which **returns false** at its deadline
// so the assertion fails with a message, and every assertion then compares the
// **whole** recorded history rather than its length.

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
    private(set) var port: UInt16 = 0

    init() throws {
        let options = NWProtocolWebSocket.Options()
        options.autoReplyPing = true
        let parameters = NWParameters.tcp
        parameters.allowLocalEndpointReuse = true
        parameters.defaultProtocolStack.applicationProtocols.insert(options, at: 0)

        listener = try NWListener(using: parameters, on: .any)
        let ready = DispatchSemaphore(value: 0)
        listener.stateUpdateHandler = { state in
            if case .ready = state { ready.signal() }
        }
        listener.newConnectionHandler = { [weak self] connection in
            guard let self else { return }
            connections.withLock { $0.append(connection) }
            log.withLock { $0.connections += 1 }
            connection.start(queue: .global())
            receive(on: connection)
        }
        listener.start(queue: .global())
        guard ready.wait(timeout: .now() + 5) == .success, let bound = listener.port else {
            throw TransportError.Failed(what: "the loopback listener never became ready")
        }
        port = bound.rawValue
    }

    func stop() {
        connections.withLock { open in
            for connection in open { connection.cancel() }
            open = []
        }
        listener.cancel()
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

    private func receive(on connection: NWConnection) {
        connection.receiveMessage { [weak self] content, context, _, error in
            guard let self else { return }
            let metadata = context?.protocolMetadata(definition: NWProtocolWebSocket.definition)
            let opcode = (metadata as? NWProtocolWebSocket.Metadata)?.opcode
            switch opcode {
            case .text:
                let text = content.flatMap { String(data: $0, encoding: .utf8) } ?? ""
                log.withLock { $0.textFrames.append(text) }
            case .binary:
                log.withLock { $0.binaryFrames.append(content ?? Data()) }
            case .close:
                log.withLock { $0.closes += 1 }
                return
            default:
                break
            }
            guard error == nil else {
                log.withLock { $0.closes += 1 }
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

    var history: [Event] { events.withLock { $0 } }

    func onOpen() { events.withLock { $0.append(.open) } }
    func onMessage(payload: Data) { events.withLock { $0.append(.message(payload)) } }
    func onClosed(code: UInt16, reason: String) { events.withLock { $0.append(.closed(code)) } }
    func onError(error: TransportError) { events.withLock { $0.append(.failed(TransportErrorKind(error))) } }
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
        let server = try LoopbackSocketServer()
        defer { server.stop() }
        let listener = RecordingListener()
        let subject = transport()

        let handle = try subject.openSocket(request: socketRequest(server), listener: listener)
        #expect(await settle { listener.history == [.open] })

        let frame = #"{"type":"changes_available","payload":{"cursor":"c1"}}"#
        server.sendText(frame)
        #expect(await settle { listener.history.count == 2 })

        handle.close()
        #expect(await settle { listener.history.count == 3 })

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
        let server = try LoopbackSocketServer()
        defer { server.stop() }
        let listener = RecordingListener()
        let subject = transport()

        let handle = try subject.openSocket(request: socketRequest(server), listener: listener)
        #expect(await settle { listener.history == [.open] })

        try handle.send(payload: Data("ping".utf8))

        #expect(await settle { server.log.withLock { $0.textFrames } == ["ping"] })
        #expect(server.log.withLock { $0.binaryFrames.isEmpty })
        withExtendedLifetime(handle) {}
    }

    /// The lifetime rule: the core holds the handle for the socket's lifetime,
    /// and dropping it closes the socket. Proven from the server's side, which
    /// is the only place a close is a fact rather than a claim.
    @Test("dropping the handle closes the socket")
    func droppingTheHandleClosesTheSocket() async throws {
        let server = try LoopbackSocketServer()
        defer { server.stop() }
        let listener = RecordingListener()
        let subject = transport()

        var handle: SocketHandle? = try subject.openSocket(request: socketRequest(server), listener: listener)
        #expect(await settle { listener.history == [.open] })
        #expect(server.log.withLock { $0.closes } == 0)

        handle = nil
        #expect(handle == nil)

        #expect(await settle { server.log.withLock { $0.closes } == 1 })
    }

    /// Chapter 09 §9.1: a client MUST close the socket when backgrounded. The
    /// reopen is `RealtimeClient::connect()`'s, because a handshake carries a
    /// bearer token this seam must never mint or reuse — so returning to the
    /// foreground must leave the socket closed and the core informed, not
    /// reopen behind the core's back and race its ladder into a second socket.
    @Test("background closes the socket and foreground does not reopen it")
    func backgroundClosesAndForegroundDoesNotReopen() async throws {
        let server = try LoopbackSocketServer()
        defer { server.stop() }
        let listener = RecordingListener()
        let subject = transport()

        let handle = try subject.openSocket(request: socketRequest(server), listener: listener)
        #expect(await settle { listener.history == [.open] })

        subject.phaseChanged(to: .background)
        #expect(await settle { listener.history == [.open, .closed(URLSessionTransport.backgroundCloseCode)] })

        subject.phaseChanged(to: .foreground)
        // Nothing new may appear: no second open here, no second connection at
        // the server. A reopen would show up as either.
        try await Task.sleep(for: .milliseconds(400))
        #expect(listener.history == [.open, .closed(URLSessionTransport.backgroundCloseCode)])
        #expect(server.log.withLock { $0.connections } == 1)
        withExtendedLifetime(handle) {}
    }

    /// A write to a socket that is already closed fails **now**, with a typed
    /// error, rather than being queued into a socket that will never send it.
    @Test("a send after the close reports the socket closed")
    func sendAfterCloseFails() async throws {
        let server = try LoopbackSocketServer()
        defer { server.stop() }
        let listener = RecordingListener()
        let subject = transport()

        let handle = try subject.openSocket(request: socketRequest(server), listener: listener)
        #expect(await settle { listener.history == [.open] })
        handle.close()
        #expect(await settle { listener.history.count == 2 })

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
        let server = try LoopbackSocketServer()
        let deadPort = server.port
        server.stop()
        // Give the listener a moment to actually release the port.
        try await Task.sleep(for: .milliseconds(200))

        let listener = RecordingListener()
        let subject = transport()
        let request = SocketRequest(url: "ws://127.0.0.1:\(deadPort)/sync/ws", headers: [:])

        let handle = try subject.openSocket(request: request, listener: listener)
        #expect(listener.history.isEmpty)

        #expect(await settle { listener.history.count == 1 })
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
}
