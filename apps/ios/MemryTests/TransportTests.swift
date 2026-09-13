import Foundation
import MemryCore
import Synchronization
import Testing

@testable import Memry

// T145, the HTTP half.
//
// **What is real here and what is substituted**, because the difference is the
// honesty of the file:
//
// - Every test in `TransportHTTPTests` runs through the **real `URLSession`
//   loading path** — the real task, the real delegate queue, the real
//   `HTTPURLResponse`, the real cancellation machinery. What is substituted is
//   the socket underneath it, by a `URLProtocol` subclass, which is the
//   standard way to intercept `URLSession` without one. **No network call is
//   made by any test in this file**, and none may be: spec-defect 93 exists
//   because a spike that called staging hung the whole plan.
// - `ResponseBodyTests` drops below the session and drives
//   `ResponseBodyBuffer` directly. That is a test of the spill mechanism, not
//   of the seam; the seam-level proof that a large body really takes the file
//   path is `oversizedBodyFailsWhenItCannotBeSpilled`, which makes the spill
//   directory unwritable and watches only the large body fail.
//
// A `URLProtocol` can produce any `URLError`, so the mapping arms below are
// reached through the real stack rather than by calling the mapping table
// directly — a test over the table alone would prove the table and not that
// `URLSession` reaches it.

// MARK: - The substitute socket

/// What the stubbed server does with the next request.
enum StubOutcome: Sendable {
    /// A complete answer, delivered in `chunks` pieces so the collector sees
    /// the same stream of `didReceive data:` callbacks a real body produces.
    case respond(status: Int, headers: [String: String], body: Data, chunks: Int)
    /// A response, part of its body, and then a connection failure. The body
    /// the core would have read is *incomplete*.
    case truncate(status: Int, headers: [String: String], partial: Data)
    /// A `URLResponse` that is not an `HTTPURLResponse`.
    case notHTTP
    case fail(URLError.Code)
    /// Never answers. Used for the deadline and the cancellation.
    case stall
    /// Answers, then sends one byte every 100 ms and never finishes. An idle
    /// timer never fires against this; only a real per-request ceiling does.
    case dribble(status: Int)
}

final class StubURLProtocol: URLProtocol, @unchecked Sendable {
    static let outcome = Mutex<StubOutcome>(.stall)
    static let captured = Mutex<[URLRequest]>([])
    private let stopped = Mutex(false)

    static func script(_ next: StubOutcome) {
        outcome.withLock { $0 = next }
        captured.withLock { $0 = [] }
    }

    static func lastRequest() -> URLRequest? {
        captured.withLock { $0.last }
    }

    // `URLProtocol` declares both as class methods, so neither can be static.
    // swiftlint:disable static_over_final_class
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    // swiftlint:enable static_over_final_class

    override func startLoading() {
        Self.captured.withLock { $0.append(request) }
        guard let url = request.url else { return }

        switch Self.outcome.withLock({ $0 }) {
        case let .respond(status, headers, body, chunks):
            deliver(url: url, status: status, headers: headers, body: body, chunks: chunks)
            client?.urlProtocolDidFinishLoading(self)
        case let .truncate(status, headers, partial):
            deliver(url: url, status: status, headers: headers, body: partial, chunks: 1)
            client?.urlProtocol(self, didFailWithError: URLError(.networkConnectionLost))
        case .notHTTP:
            let response = URLResponse(
                url: url, mimeType: "application/json", expectedContentLength: 0, textEncodingName: nil
            )
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocolDidFinishLoading(self)
        case let .fail(code):
            client?.urlProtocol(self, didFailWithError: URLError(code))
        case .stall:
            break
        case let .dribble(status):
            let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: [:])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            dribble()
        }
    }

    override func stopLoading() {
        stopped.withLock { $0 = true }
    }

    private func dribble() {
        DispatchQueue.global().asyncAfter(deadline: .now() + .milliseconds(100)) { [weak self] in
            guard let self, !stopped.withLock({ $0 }) else { return }
            client?.urlProtocol(self, didLoad: Data([0x20]))
            dribble()
        }
    }

    private func deliver(url: URL, status: Int, headers: [String: String], body: Data, chunks: Int) {
        let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        guard !body.isEmpty else { return }
        let size = max(1, body.count / max(1, chunks))
        var offset = body.startIndex
        while offset < body.endIndex {
            let end = body.index(offset, offsetBy: size, limitedBy: body.endIndex) ?? body.endIndex
            client?.urlProtocol(self, didLoad: body[offset..<end])
            offset = end
        }
    }
}

// MARK: - Identity, not truthiness

/// One `TransportError` reduced to which variant it is.
///
/// This exists so `Cancelled`, `Timeout` and `Tls` are compared **by identity**
/// rather than by "an error was thrown". Collapsing any two of them is the
/// specific bug this seam's enum was shaped to prevent, and a test that only
/// asserted `#expect(throws:)` would pass under every one of those collapses.
enum TransportErrorKind: String, Sendable {
    case offline, timeout, tls, cancelled, failed, socketClosed, notATransportError

    init(_ error: any Error) {
        switch error as? TransportError {
        case .Offline: self = .offline
        case .Timeout: self = .timeout
        case .Tls: self = .tls
        case .Cancelled: self = .cancelled
        case .Failed: self = .failed
        case .SocketClosed: self = .socketClosed
        case nil: self = .notATransportError
        }
    }
}

private func kind(of work: () async throws -> HttpResponse) async -> TransportErrorKind? {
    do {
        _ = try await work()
        return nil
    } catch {
        return TransportErrorKind(error)
    }
}

private func request(
    _ method: String = "GET",
    path: String = "/sync/pull",
    headers: [String: String] = [:],
    timeoutMs: UInt64 = 5_000
) -> HttpRequest {
    HttpRequest(
        method: method,
        url: "https://transport.test\(path)",
        headers: headers,
        body: nil,
        timeoutMs: timeoutMs
    )
}

@Suite("Transport over URLSession", .serialized, .timeLimit(.minutes(1)))
struct TransportHTTPTests {
    private let hub = CoreEvents()
    private let spillDirectory: URL

    init() throws {
        spillDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent("t145-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: spillDirectory, withIntermediateDirectories: true)
    }

    private func transport(spillThresholdBytes: Int = 1024, spillDirectory: URL? = nil) -> URLSessionTransport {
        let configuration = URLSessionTransport.defaultConfiguration()
        configuration.protocolClasses = [StubURLProtocol.self]
        return URLSessionTransport(
            emitter: hub.emitter,
            configuration: configuration,
            spillThresholdBytes: spillThresholdBytes,
            spillDirectory: spillDirectory ?? self.spillDirectory
        )
    }

    // MARK: A non-2xx is a response

    /// The single most consequential assertion in this file. A permanently
    /// rejected record already wedges the outbox; a transport that turned the
    /// 400 into a `TransportError` would make that bug undiagnosable as well as
    /// unfixable, because the core would never see the code in the body.
    @Test("a 400 arrives as a response whose body the core can read, not as an error")
    func nonSuccessStatusIsAResponse() async throws {
        let envelope = Data(#"{"error":{"code":"VALIDATION_ERROR"}}"#.utf8)
        StubURLProtocol.script(.respond(status: 400, headers: [:], body: envelope, chunks: 1))

        let response = try await transport().send(request: request("POST", path: "/auth/otp/request"))

        #expect(response.status == 400)
        #expect(response.body == envelope)
    }

    @Test("a 429 arrives as a response too, with its body intact")
    func rateLimitIsAResponse() async throws {
        let envelope = Data(#"{"error":{"code":"RATE_LIMITED"}}"#.utf8)
        StubURLProtocol.script(.respond(status: 429, headers: ["Retry-After": "42"], body: envelope, chunks: 1))

        let response = try await transport().send(request: request())

        #expect(response.status == 429)
        #expect(response.body == envelope)
    }

    // MARK: Lowercase in both directions

    /// Chapter 00 §0.6 reads `retry-after` from a 429 **in lowercase**, and
    /// `URLSession` makes no promise about response-header casing. A server
    /// that answers `Retry-After` must reach the core as `retry-after`.
    @Test("response header keys are lowercased whatever casing the server used")
    func responseHeadersAreLowercased() async throws {
        StubURLProtocol.script(.respond(
            status: 429,
            headers: ["Retry-After": "42", "X-Memry-Cursor": "abc", "CONTENT-TYPE": "application/json"],
            body: Data(),
            chunks: 1
        ))

        let response = try await transport().send(request: request())

        #expect(response.headers["retry-after"] == "42")
        #expect(response.headers["x-memry-cursor"] == "abc")
        #expect(response.headers["content-type"] == "application/json")
        // The casing the server used must not survive alongside it: two keys
        // for one header is how a reader finds the wrong one.
        #expect(response.headers["Retry-After"] == nil)
        #expect(response.headers["X-Memry-Cursor"] == nil)
    }

    @Test("request header keys go out lowercased")
    func requestHeadersAreLowercased() async throws {
        StubURLProtocol.script(.respond(status: 200, headers: [:], body: Data(), chunks: 1))

        _ = try await transport().send(request: request(headers: [
            "X-Memry-Vault-Id": "vault-a",
            "X-App-Version": "1.2.3"
        ]))

        let sent = try #require(StubURLProtocol.lastRequest()?.allHTTPHeaderFields)
        #expect(sent["x-memry-vault-id"] == "vault-a")
        #expect(sent["x-app-version"] == "1.2.3")
    }

    // MARK: The mapping, by identity

    /// Three failures that all "are an error", told apart.
    ///
    /// Both of the first two end in a cancelled `URLSessionTask`: one has its
    /// own ceiling elapse, the other is cancelled by its caller, and
    /// `URLSession` reports **both** as `URLError.cancelled` — so anything that
    /// read the error alone would collapse them. The timeout leg uses the
    /// *dribbling* server on purpose: against a server that says nothing,
    /// `URLRequest.timeoutInterval` ends the request as `URLError.timedOut`
    /// and this assertion passes with the whole deadline mechanism deleted.
    /// It was observed doing exactly that — and collapsing `Cancelled` charges a
    /// user's own cancel against the retry budget, while collapsing `Tls`
    /// retries a certificate failure into a loop.
    @Test("a deadline, a caller's cancel and a TLS refusal are three different variants")
    func cancelTimeoutAndTlsAreDistinct() async throws {
        let subject = transport()
        StubURLProtocol.script(.dribble(status: 200))

        let timedOut = await kind { try await subject.send(request: request(timeoutMs: 250)) }

        StubURLProtocol.script(.stall)
        let inFlight = Task { try await subject.send(request: request(timeoutMs: 30_000)) }
        try await Task.sleep(for: .milliseconds(100))
        inFlight.cancel()
        let cancelled: TransportErrorKind? = await {
            do {
                _ = try await inFlight.value
                return nil
            } catch {
                return TransportErrorKind(error)
            }
        }()

        StubURLProtocol.script(.fail(.secureConnectionFailed))
        let refused = await kind { try await subject.send(request: request()) }

        #expect(timedOut == .timeout)
        #expect(cancelled == .cancelled)
        #expect(refused == .tls)
        // Pairwise, so a collapse of any two fails here even if each one alone
        // still looks like "an error".
        #expect(timedOut != cancelled)
        #expect(cancelled != refused)
        #expect(timedOut != refused)
        #expect(refused != .failed)
    }

    /// `URLRequest.timeoutInterval` is an *idle* timer: the gap between bytes
    /// here is 100 ms and the ceiling is 400 ms, so the idle timer never fires
    /// and only a real per-request deadline ends this request. Chapter 00 §0.6
    /// makes the ceiling mandatory because the in-flight guard latches without
    /// one — and a server that dribbles is exactly the case a session default
    /// does not cover.
    @Test("the ceiling is the request's own, and it beats a dribbling server")
    func perRequestCeilingBeatsADribblingServer() async throws {
        StubURLProtocol.script(.dribble(status: 200))
        let started = ContinuousClock.now

        let outcome = await kind { try await transport().send(request: request(timeoutMs: 400)) }
        let elapsed = ContinuousClock.now - started

        #expect(outcome == .timeout)
        #expect(elapsed < .seconds(5))
    }

    @Test("a dead network path is Offline, which is the variant reachability drives")
    func noPathIsOffline() async throws {
        StubURLProtocol.script(.fail(.notConnectedToInternet))
        #expect(await kind { try await transport().send(request: request()) } == .offline)
    }

    @Test("an unparseable URL fails without a request ever being made")
    func unparseableURLNeverLeaves() async throws {
        StubURLProtocol.script(.respond(status: 200, headers: [:], body: Data(), chunks: 1))
        var broken = request()
        broken.url = ""

        let outcome = await kind { try await transport().send(request: broken) }

        #expect(outcome == .failed)
        #expect(StubURLProtocol.lastRequest() == nil)
    }

    // MARK: Could not tell is never nothing there

    /// A body that arrived in part must not reach the core as a short body. An
    /// empty body reaching an applier is a content wipe (chapter 04 §4.1).
    ///
    /// The variant is `Offline`, because the cause here really is a lost
    /// connection; what this test is about is the `nil` it is not — a 200
    /// carrying the 8 bytes that made it.
    @Test("a body cut off mid-stream throws rather than arriving short")
    func truncatedBodyIsNotAShortBody() async throws {
        StubURLProtocol.script(.truncate(
            status: 200,
            headers: ["content-length": "4096"],
            partial: Data(repeating: 0x41, count: 8)
        ))

        let outcome = await kind { try await transport().send(request: request()) }

        #expect(outcome != nil)
        #expect(outcome == .offline)
    }

    @Test("a response that is not HTTP is no answer, not a zero-status one")
    func nonHTTPResponseIsNotAnAnswer() async throws {
        StubURLProtocol.script(.notHTTP)
        #expect(await kind { try await transport().send(request: request()) } == .failed)
    }

    /// The contrast that keeps the two tests above honest: a body that really
    /// is empty still arrives, as a 204 with no bytes.
    @Test("a genuinely empty body is a response with no bytes")
    func emptyBodyIsStillAResponse() async throws {
        StubURLProtocol.script(.respond(status: 204, headers: [:], body: Data(), chunks: 1))

        let response = try await transport().send(request: request())

        #expect(response.status == 204)
        #expect(response.body.isEmpty)
    }

    // MARK: The blob path

    @Test("a body past the threshold round-trips byte-identical and leaves no file behind")
    func oversizedBodySurvivesTheFilePath() async throws {
        var body = Data(count: 0)
        for index in 0..<4096 { body.append(UInt8(index % 251)) }
        StubURLProtocol.script(.respond(status: 200, headers: [:], body: body, chunks: 16))

        let response = try await transport(spillThresholdBytes: 1024).send(request: request())

        #expect(response.body == body)
        // Unlinked as soon as it was mapped: nothing of an attachment is left
        // on disk after the call.
        #expect(try FileManager.default.contentsOfDirectory(atPath: spillDirectory.path).isEmpty)
    }

    /// The seam-level proof that the large body really takes the file path and
    /// the small one does not: with an unwritable spill directory, only the one
    /// over the threshold fails, and it fails rather than returning what it
    /// managed to keep.
    @Test("only a body over the threshold needs the spill file")
    func oversizedBodyFailsWhenItCannotBeSpilled() async throws {
        let unwritable = spillDirectory.appendingPathComponent("does/not/exist")
        let subject = transport(spillThresholdBytes: 1024, spillDirectory: unwritable)

        StubURLProtocol.script(.respond(status: 200, headers: [:], body: Data(repeating: 0x42, count: 64), chunks: 1))
        let small = try await subject.send(request: request())

        StubURLProtocol.script(.respond(status: 200, headers: [:], body: Data(repeating: 0x42, count: 4096), chunks: 8))
        let large = await kind { try await subject.send(request: request()) }

        #expect(small.body.count == 64)
        #expect(large == .failed)
    }

    @Test("the shipped threshold is one mebibyte")
    func thresholdIsOneMebibyte() {
        #expect(URLSessionTransport.defaultSpillThresholdBytes == 1_048_576)
    }

    // MARK: No policy of its own

    /// A redirect is a second request, and this seam makes one. Following it
    /// would also replay the `authorization` header at whatever host the
    /// `Location` names.
    @Test("a redirect is handed to the core as a response, not followed")
    func redirectsAreNotFollowed() async throws {
        StubURLProtocol.script(.respond(
            status: 302,
            headers: ["Location": "https://elsewhere.test/steal"],
            body: Data(),
            chunks: 1
        ))

        let response = try await transport().send(request: request())

        #expect(response.status == 302)
        #expect(response.headers["location"] == "https://elsewhere.test/steal")
        #expect(StubURLProtocol.captured.withLock { $0.count } == 1)
    }

    /// `waitsForConnectivity` is a retry the core cannot see, cancel or budget.
    @Test("the session never waits for connectivity")
    func sessionDoesNotWaitForConnectivity() {
        #expect(URLSessionTransport.defaultConfiguration().waitsForConnectivity == false)
    }
}

// MARK: - Below the session

@Suite("Transport response body buffer")
struct ResponseBodyTests {
    private func directory() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("t145-buffer-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    @Test("a body under the threshold never touches the disk")
    func smallBodyStaysResident() throws {
        let url = try directory()
        let buffer = ResponseBodyBuffer(thresholdBytes: 1024, directory: url)
        buffer.append(Data(repeating: 0x01, count: 512))

        #expect(try buffer.finish() == Data(repeating: 0x01, count: 512))
        #expect(buffer.didSpill == false)
        #expect(try FileManager.default.contentsOfDirectory(atPath: url.path).isEmpty)
    }

    @Test("a body over the threshold spills, and every byte survives in order")
    func largeBodySpills() throws {
        let url = try directory()
        let buffer = ResponseBodyBuffer(thresholdBytes: 1024, directory: url)
        var expected = Data()
        for index in 0..<64 {
            let chunk = Data(repeating: UInt8(index), count: 100)
            expected.append(chunk)
            buffer.append(chunk)
        }

        let finished = try buffer.finish()

        #expect(buffer.didSpill)
        #expect(finished == expected)
        #expect(finished.count == 6400)
        #expect(try FileManager.default.contentsOfDirectory(atPath: url.path).isEmpty)
    }

    @Test("a spill that could not be written throws instead of returning what it kept")
    func unwritableSpillThrows() throws {
        let buffer = ResponseBodyBuffer(
            thresholdBytes: 16,
            directory: try directory().appendingPathComponent("nope/nope")
        )
        buffer.append(Data(repeating: 0x07, count: 64))

        #expect(throws: TransportError.self) { try buffer.finish() }
    }
}
