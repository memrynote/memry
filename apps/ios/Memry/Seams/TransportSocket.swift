import Foundation
import MemryCore
import Synchronization

/// T145, the realtime half of the one `Transport` seam. Split out of
/// `Transport.swift` for size only; there is still exactly one `Transport`
/// conformance.
///
/// **The socket is never a data path** (chapter 09). Every frame is a hint that
/// causes a pull, and nothing here parses one — not even to log it. `onMessage`
/// carries the bytes exactly as they arrived, which is the whole reason the
/// seam models a payload as bytes rather than as a type.
///
/// **No reconnect lives here.** §9.10's ladder, its latches and its terminal
/// close codes are the core's. This file opens a socket when asked, reports
/// what the socket does, and closes it when it is told to or when the app
/// leaves the foreground.
final class SocketRouter: NSObject, URLSessionWebSocketDelegate, @unchecked Sendable {
    /// Weak on purpose: the core holds the `SocketHandle` for the socket's
    /// lifetime and dropping it must close the socket, so nothing else may keep
    /// the connection alive — least of all the long-lived session delegate.
    private struct Slot {
        weak var connection: WebSocketConnection?
    }

    private let slots = Mutex<[Int: Slot]>([:])

    func register(_ connection: WebSocketConnection, for identifier: Int) {
        slots.withLock { table in
            table = table.filter { $0.value.connection != nil }
            table[identifier] = Slot(connection: connection)
        }
    }

    func connection(for identifier: Int) -> WebSocketConnection? {
        slots.withLock { $0[identifier]?.connection }
    }

    /// Chapter 09 §9.1: a conforming client MUST close the socket when
    /// backgrounded. Returns how many were live, for the log line.
    func closeAllForBackground(code: UInt16) -> Int {
        let live: [WebSocketConnection] = slots.withLock { table in
            table = table.filter { $0.value.connection != nil }
            return table.values.compactMap(\.connection)
        }
        for connection in live {
            connection.closeForBackground(code: code)
        }
        return live.count
    }

    // MARK: - URLSessionWebSocketDelegate

    func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didOpenWithProtocol protocol: String?
    ) {
        connection(for: webSocketTask.taskIdentifier)?.reportOpen()
    }

    func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
        reason: Data?
    ) {
        connection(for: webSocketTask.taskIdentifier)?.reportClosed(
            code: UInt16(clamping: closeCode.rawValue),
            reason: WebSocketConnection.text(of: reason)
        )
    }

    /// A client-initiated close and a handshake that never completed both land
    /// here rather than in `didCloseWith`.
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: (any Error)?) {
        connection(for: task.taskIdentifier)?.reportCompletion(error)
    }
}

/// The `SocketHandle` the core holds. Dropping it closes the socket.
final class WebSocketConnection: NSObject, SocketHandle, @unchecked Sendable {
    private struct State {
        /// Latched by the first terminal report, so a close delivered as both
        /// `didCloseWith` and `didCompleteWithError` is told to the core once.
        var finished = false
        var open = false
        /// The code this side sent, so a close it initiated is reported as the
        /// code it asked for rather than as 1000 by default.
        var initiatedCode: UInt16?
    }

    private let task: URLSessionWebSocketTask
    private let listener: SocketListener
    private let emitter: CoreEventEmitter
    private let state = Mutex(State())

    init(task: URLSessionWebSocketTask, listener: SocketListener, emitter: CoreEventEmitter) {
        self.task = task
        self.listener = listener
        self.emitter = emitter
        super.init()
        receiveNext()
    }

    /// The lifetime rule, in one line: the core drops the handle, the socket
    /// closes. Nothing is reported — the core let go, so it is not waiting to
    /// hear about it, and calling the listener from a deallocation would be a
    /// call into a core that may already have released the other side.
    deinit {
        task.cancel(with: .goingAway, reason: nil)
    }

    // MARK: - SocketHandle

    /// Queues one frame.
    ///
    /// **Asynchronous underneath, and it has to be.** `URLSessionWebSocketTask`
    /// acknowledges a write through a completion handler, and this method is
    /// called from a Rust thread; blocking that thread on a network write would
    /// park the core inside a seam. So a socket already closed fails here and
    /// now, with the code it closed on, and a write that fails afterwards is
    /// reported through `onError`, which is the channel the core already reads
    /// for a socket that stopped working.
    ///
    /// **The frame goes out as text when the bytes are UTF-8.** Chapter 09 has
    /// no binary frames at all: §9.6's keepalive is the literal text `ping`,
    /// which Cloudflare answers from a request-response pair without waking the
    /// Durable Object, and §9.4's envelope is JSON. The seam carries bytes with
    /// no opcode, so this is the framing choice that makes the core's own
    /// `KEEPALIVE_FRAME` arrive as the thing the server matches. It is a
    /// framing decision, not a parse: nothing reads what the bytes say.
    func send(payload: Data) throws {
        let closed: UInt16? = state.withLock { current in
            current.finished ? (current.initiatedCode ?? 0) : nil
        }
        if let closed {
            throw TransportError.SocketClosed(code: closed, reason: "the socket is closed")
        }

        let message: URLSessionWebSocketTask.Message
        if let text = String(data: payload, encoding: .utf8) {
            message = .string(text)
        } else {
            message = .data(payload)
        }
        task.send(message) { [weak self] error in
            guard let self, let error else { return }
            report(error: error)
        }
    }

    /// Called by the core when it no longer wants the socket.
    ///
    /// **It reports nothing inline.** This method is dispatched by UniFFI on
    /// the calling Rust thread, and a Swift method Rust calls must not re-enter
    /// the core; the close lands on the session's delegate queue and is
    /// reported from there.
    func close() {
        state.withLock { $0.initiatedCode = UInt16(URLSessionWebSocketTask.CloseCode.normalClosure.rawValue) }
        task.cancel(with: .normalClosure, reason: nil)
    }

    // MARK: - Reports

    func reportOpen() {
        let first: Bool = state.withLock { current in
            guard !current.finished, !current.open else { return false }
            current.open = true
            return true
        }
        guard first else { return }
        Log.transport.info("realtime socket opened")
        listener.onOpen()
        emitter.emit(CoreEvent(.realtimeSocket))
    }

    func reportClosed(code: UInt16, reason: String) {
        guard finish() else { return }
        Log.transport.notice("realtime socket closed", .status(Int(code)))
        listener.onClosed(code: code, reason: reason)
        emitter.emit(CoreEvent(.realtimeSocket))
    }

    /// The task ended. A client-initiated close arrives here with no error, a
    /// failed handshake with one.
    func reportCompletion(_ error: (any Error)?) {
        guard let error else {
            let code = state.withLock { $0.initiatedCode }
                ?? UInt16(URLSessionWebSocketTask.CloseCode.normalClosure.rawValue)
            reportClosed(code: code, reason: "the socket ended")
            return
        }
        report(error: error)
    }

    /// Chapter 09 §9.1 again: closed for the background, and **not** reopened
    /// on return. See `URLSessionTransport.phaseChanged(to:)` for why the
    /// reopen cannot be this seam's.
    func closeForBackground(code: UInt16) {
        state.withLock { $0.initiatedCode = code }
        task.cancel(with: .goingAway, reason: nil)
        reportClosed(code: code, reason: "the app left the foreground")
    }

    private func report(error: any Error) {
        guard finish() else { return }
        let mapped = TransportErrorMapping.map(error, elapsedMs: 0)
        Log.transport.error("realtime socket failed")
        listener.onError(error: mapped)
        emitter.emit(CoreEvent(.realtimeSocket))
    }

    /// Latches. Returns whether this call is the one that gets to report.
    private func finish() -> Bool {
        state.withLock { current in
            guard !current.finished else { return false }
            current.finished = true
            current.open = false
            return true
        }
    }

    // MARK: - Receiving

    /// The pump. `[weak self]` is load-bearing: a strong capture here would
    /// keep the connection alive inside its own pending read, and dropping the
    /// handle would then not close the socket.
    private func receiveNext() {
        task.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case let .success(message):
                deliver(message)
                receiveNext()
            case let .failure(error):
                report(error: error)
            }
        }
    }

    private func deliver(_ message: URLSessionWebSocketTask.Message) {
        let payload: Data?
        switch message {
        case let .data(data):
            payload = data
        case let .string(text):
            // The bytes of the frame, not a reading of it. A text frame is
            // UTF-8 by definition, so this is the inverse of the framing choice
            // in `send`, and it is the only transformation in this file.
            payload = text.data(using: .utf8)
        @unknown default:
            payload = nil
        }
        guard let payload else {
            // A frame shape this SDK invented and this build does not know is
            // **not** an empty frame. Reporting it as one would hand the core a
            // hint that carried nothing, which reads as a frame that said
            // nothing rather than as one that could not be read.
            report(error: TransportError.Failed(what: "an unreadable socket frame arrived"))
            return
        }
        listener.onMessage(payload: payload)
        emitter.emit(CoreEvent(.realtimeSocket))
    }

    static func text(of reason: Data?) -> String {
        guard let reason, let text = String(data: reason, encoding: .utf8) else { return "" }
        return text
    }
}
