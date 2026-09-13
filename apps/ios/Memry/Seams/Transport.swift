import Foundation
import MemryCore

/// T145. The one network seam, over `URLSession`
/// (`crates/memry-core/src/seams/transport.rs`,
/// `contracts/shell-seams.md` §"Transport is one trait, and it is dumb",
/// research R5, FR-017).
///
/// **It is deliberately dumb.** One request in, status plus lowercase headers
/// plus bytes out. There is no retry here, no backoff, no token refresh, no
/// cursor and no reconnect: every one of those is a policy the core already
/// owns, and a second copy on this side disagrees with it the first time either
/// changes. The session is configured to make that hard rather than to make it
/// a rule — `waitsForConnectivity` is off, because a session that waits for a
/// path has silently become a retry the core cannot see or cancel.
///
/// **A non-2xx status is a response.** The core reads the body to find the
/// error code (chapter 00 §0.4), and `TransportError` is only for the cases
/// where no response exists at all. A 400 returned as `.failure` here would
/// make every server error code invisible to the core, including the one behind
/// the outbox wedge.
///
/// **Rust calls `send` and `openSocket`, so neither re-enters the core.**
/// `openSocket` in particular never calls its listener inline: readiness and
/// failure both arrive later, from the session's own delegate queue
/// (`contracts/shell-seams.md` §"There is no event seam"). What this seam tells
/// the UI, it tells through ``CoreEventEmitter``, whose whole surface is a
/// synchronous `Void` `emit` — and never the frame.
///
/// **Nothing logs a URL, a header, or a body byte.** A request to this server
/// carries a bearer token in a header and an encrypted payload in a body; a
/// logged URL or header is a credential leak (Constitution II, FR-023). `Log`
/// makes that structural rather than careful: every message is a `StaticString`
/// and the only companion is a number, so there is nowhere to put a URL even by
/// accident. Status and elapsed milliseconds are all that is recorded.
final class URLSessionTransport: Transport, @unchecked Sendable {
    /// Above this many bytes a response body stops being held in memory and is
    /// streamed to a file instead (research R5's gotcha).
    ///
    /// **1 MiB, chosen from the protocol rather than from taste.** Encrypted
    /// item payloads live in R2 precisely because a D1 row caps at 1 MB, so
    /// every ordinary sync response — record batches, CRDT updates, auth — is
    /// under a megabyte and never touches the disk. What is over it is an
    /// attachment body (chapter 14), which is exactly the fetch that kills a
    /// phone when it is accumulated in one contiguous `Data`. The threshold is
    /// applied to bytes actually received, not to a declared `Content-Length`,
    /// because a chunked response declares none and a server may lie about one.
    static let defaultSpillThresholdBytes = 1 << 20

    /// The default close code for a socket this seam closes because the app
    /// left the foreground. 1001 "going away" is the standard endpoint-is-
    /// leaving code, and it is deliberately not one of chapter 09 §9.9's
    /// server codes: none of those describes the shell, and borrowing 4001
    /// would tell the core another device replaced this socket.
    static let backgroundCloseCode: UInt16 = 1001

    private let collector: HTTPResponseCollector
    private let session: URLSession
    private let socketSession: URLSession
    private let socketRouter: SocketRouter
    private let emitter: CoreEventEmitter

    /// - Parameters:
    ///   - emitter: the shell's event hub, never the hub itself and never the
    ///     core executor. See ``CoreEventEmitter``.
    ///   - configuration: injected so a test can register a `URLProtocol` and
    ///     exercise the real `URLSession` loading path without a network.
    ///   - spillThresholdBytes: see ``defaultSpillThresholdBytes``.
    ///   - spillDirectory: where an oversized body is streamed. The file is
    ///     unlinked as soon as it is mapped, so nothing survives the call.
    init(
        emitter: CoreEventEmitter,
        configuration: URLSessionConfiguration = URLSessionTransport.defaultConfiguration(),
        spillThresholdBytes: Int = URLSessionTransport.defaultSpillThresholdBytes,
        spillDirectory: URL = FileManager.default.temporaryDirectory
    ) {
        self.emitter = emitter
        collector = HTTPResponseCollector(
            spillThresholdBytes: spillThresholdBytes,
            spillDirectory: spillDirectory
        )
        socketRouter = SocketRouter()
        session = URLSession(
            configuration: configuration,
            delegate: collector,
            delegateQueue: URLSessionTransport.delegateQueue(named: "transport.http")
        )
        socketSession = URLSession(
            configuration: configuration,
            delegate: socketRouter,
            delegateQueue: URLSessionTransport.delegateQueue(named: "transport.socket")
        )
    }

    /// A `URLSession` holds its delegate until it is invalidated, and the
    /// loading system holds the session, so a transport that simply went out of
    /// scope would leak both and leave its sockets open.
    deinit {
        session.invalidateAndCancel()
        socketSession.invalidateAndCancel()
    }

    // MARK: - Transport

    func send(request: HttpRequest) async throws -> HttpResponse {
        guard let url = URL(string: request.url) else {
            // No request was ever made, so this is a transport failure rather
            // than a response. It is not retryable in practice, but `Failed`
            // is the honest variant: the core owns what to do about it.
            throw TransportError.Failed(what: "the request URL could not be parsed")
        }

        var urlRequest = URLRequest(url: url)
        urlRequest.httpMethod = request.method
        urlRequest.httpBody = request.body
        // The per-request ceiling is mandatory (chapter 00 §0.6) and it is the
        // request's, never a session default. `timeoutInterval` is an *idle*
        // timer, so it is set here and backed by a real deadline in the
        // collector: a server dribbling one byte a second would otherwise never
        // trip it, and the in-flight guard it exists to protect would latch.
        urlRequest.timeoutInterval = TimeInterval(request.timeoutMs) / 1000
        for (name, value) in request.headers {
            // Lowercase in both directions, from the contract. HTTP header
            // names are case-insensitive on the wire, so this costs nothing and
            // keeps one casing across the seam.
            urlRequest.setValue(value, forHTTPHeaderField: name.lowercased())
        }

        let started = DispatchTime.now()
        let response = try await collector.perform(urlRequest, timeoutMs: request.timeoutMs, in: session)
        Log.transport.info(
            "http exchange completed",
            .status(Int(response.status))
        )
        Log.transport.debug("http exchange elapsed", .milliseconds(Self.elapsedMs(since: started)))
        return response
    }

    func openSocket(request: SocketRequest, listener: SocketListener) throws -> SocketHandle {
        guard let url = URL(string: request.url) else {
            throw TransportError.Failed(what: "the socket URL could not be parsed")
        }

        var urlRequest = URLRequest(url: url)
        for (name, value) in request.headers {
            urlRequest.setValue(value, forHTTPHeaderField: name.lowercased())
        }

        // Chapter 09 §9.2: authentication is handshake headers only, never a
        // query parameter and never a subprotocol. The headers arrive built by
        // the core; nothing is added here.
        let task = socketSession.webSocketTask(with: urlRequest)
        let connection = WebSocketConnection(task: task, listener: listener, emitter: emitter)
        socketRouter.register(connection, for: task.taskIdentifier)
        // Resumed after registration, so the open callback cannot arrive before
        // the router knows who it belongs to. No listener call happens on this
        // thread: `openSocket` is called from Rust, and a Swift method Rust
        // calls must not re-enter the core.
        task.resume()
        Log.transport.info("realtime socket opening")
        return connection
    }

    // MARK: - Lifecycle

    /// Closes every live socket because the app left the foreground, and tells
    /// the core each one closed (chapter 09 §9.1: a client MUST close the
    /// socket when backgrounded; a frozen socket costs a wake per broadcast and
    /// cannot be serviced).
    ///
    /// **Nothing is reopened here, and that is deliberate rather than
    /// unfinished.** Reopening needs a fresh handshake, and a handshake carries
    /// `Authorization: Bearer <accessToken>` — a token this seam must never
    /// mint, refresh or reuse after a background of unknown length. Reopening
    /// is `RealtimeClient::connect()`'s, which rebuilds the handshake from the
    /// core's own token provider and applies §9.10's ladder; a shell that
    /// reopened on its own would race that ladder and produce the second socket
    /// §9.3 says kills the first.
    ///
    /// The close is reported rather than hidden for the same reason: a core
    /// that still believes the socket is open is a core that will not pull.
    ///
    /// **Nothing calls this yet.** The phase belongs to `RuntimeHost`, whose
    /// `on_background`/`on_foreground` the app root drives from one scene-phase
    /// transition; this is a second consumer of that one transition, not a
    /// second lifecycle path. T158 owns the app root that will fan it out.
    func phaseChanged(to phase: AppPhase) {
        switch phase {
        case .background, .expiring:
            let closed = socketRouter.closeAllForBackground(code: Self.backgroundCloseCode)
            if closed > 0 {
                Log.transport.notice("realtime sockets closed for background", .count(closed))
            }
        case .foreground:
            // Deliberately nothing. See above.
            break
        }
    }

    // MARK: - Session

    /// Ephemeral on purpose: no disk cache, no cookie jar, no credential store.
    /// A sync response body is ciphertext and a URL identifies a vault, and
    /// neither belongs in a cache this app never reads.
    static func defaultConfiguration() -> URLSessionConfiguration {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        // **Off.** When this is on, `URLSession` holds a request until a path
        // appears instead of failing — a retry, owned by the shell, invisible
        // to the core and outside its budget. The core wants `Offline` now and
        // drives its own retry from the reachability transition.
        configuration.waitsForConnectivity = false
        // Left at the defaults: whether an expensive or constrained path may be
        // used is the core's policy, informed by the `Reachability` seam, not a
        // decision this seam gets to take.
        return configuration
    }

    private static func delegateQueue(named name: String) -> OperationQueue {
        let queue = OperationQueue()
        // Serial: the delegate's per-task bookkeeping is then ordered without
        // depending on the lock for ordering, only for safety.
        queue.maxConcurrentOperationCount = 1
        queue.name = "com.memry.ios.\(name)"
        return queue
    }

    static func elapsedMs(since started: DispatchTime) -> UInt64 {
        (DispatchTime.now().uptimeNanoseconds &- started.uptimeNanoseconds) / 1_000_000
    }
}

/// The whole mapping table, and the reason this seam has one.
///
/// Two rows are load-bearing and neither may be collapsed
/// (`contracts/shell-seams.md` §"Why these particular enums have the variants
/// they do"):
///
/// * `Cancelled` — a cancel is the user's decision and must not count against a
///   retry budget (chapter 00 §0.6). Collapsed into `Failed`, every cancelled
///   request spends an attempt the user asked not to spend.
/// * `Tls` — a certificate failure reproduces exactly on the next attempt.
///   Collapsed into `Failed`, the ladder retries a possible interception into a
///   loop.
enum TransportErrorMapping {
    /// - Parameter deadlineExceeded: whether *this* seam cancelled the task
    ///   because the request's own ceiling elapsed. `URLSession` reports that
    ///   cancellation as `URLError.cancelled`, which is indistinguishable from
    ///   the caller's own cancel at the error alone — so the two are told apart
    ///   by who did it, not by what came back.
    static func map(_ error: any Error, elapsedMs: UInt64, deadlineExceeded: Bool = false) -> TransportError {
        if let transportError = error as? TransportError { return transportError }
        guard let urlError = error as? URLError else {
            if error is CancellationError { return .Cancelled }
            return .Failed(what: describe(error))
        }
        switch urlError.code {
        case .cancelled:
            return deadlineExceeded ? .Timeout(elapsedMs: elapsedMs) : .Cancelled
        case .timedOut:
            return .Timeout(elapsedMs: elapsedMs)
        case .notConnectedToInternet, .networkConnectionLost, .dataNotAllowed,
             .cannotConnectToHost, .internationalRoamingOff, .callIsActive,
             .cannotFindHost, .dnsLookupFailed:
            return .Offline
        case .secureConnectionFailed, .serverCertificateUntrusted,
             .serverCertificateHasBadDate, .serverCertificateHasUnknownRoot,
             .serverCertificateNotYetValid, .clientCertificateRejected,
             .clientCertificateRequired, .appTransportSecurityRequiresSecureConnection:
            return .Tls(what: "TLS failure \(urlError.code.rawValue)")
        default:
            return .Failed(what: "URLError \(urlError.code.rawValue)")
        }
    }

    /// A type name and nothing else. `localizedDescription` on a `URLError`
    /// embeds the failing URL, and every generated core error renders its own
    /// associated values, so neither may be interpolated into a string the core
    /// may later log or show.
    static func describe(_ error: any Error) -> String {
        "\(type(of: error))"
    }
}
