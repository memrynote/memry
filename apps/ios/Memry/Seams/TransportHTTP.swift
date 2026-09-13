import Foundation
import MemryCore
import Synchronization

/// T145, the HTTP half of the one `Transport` seam. Split out of
/// `Transport.swift` for size only: there is still exactly one `Transport`
/// conformance, because the trait is deliberately one seam.
///
/// This is a `URLSessionDataDelegate` rather than a call to
/// `URLSession.data(for:)` for one reason, and it is the reason R5 gives: a
/// large blob fetch must not be accumulated into one contiguous in-memory
/// buffer, because that is how a phone gets killed fetching an attachment.
/// Seeing each chunk as it arrives is what makes the spill in
/// ``ResponseBodyBuffer`` possible at all.
final class HTTPResponseCollector: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private let exchanges = Mutex<[Int: HTTPExchange]>([:])
    private let spillThresholdBytes: Int
    private let spillDirectory: URL

    init(spillThresholdBytes: Int, spillDirectory: URL) {
        self.spillThresholdBytes = spillThresholdBytes
        self.spillDirectory = spillDirectory
    }

    /// Runs one request to completion and returns the response, whatever its
    /// status. Throws only when **no response exists at all**.
    func perform(_ request: URLRequest, timeoutMs: UInt64, in session: URLSession) async throws -> HttpResponse {
        let task = session.dataTask(with: request)
        let exchange = HTTPExchange(
            body: ResponseBodyBuffer(thresholdBytes: spillThresholdBytes, directory: spillDirectory)
        )
        exchanges.withLock { $0[task.taskIdentifier] = exchange }

        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<HttpResponse, any Error>) in
                exchanges.withLock { _ in exchange.attach(continuation) }
                task.resume()
                armDeadline(for: task, timeoutMs: timeoutMs)
            }
        } onCancel: {
            // The outer caller asked to stop. `URLSession` reports this as
            // `URLError.cancelled` with no deadline flag set, which is what
            // keeps it distinct from the ceiling elapsing: a cancel must not
            // count against the core's retry budget (chapter 00 §0.6).
            task.cancel()
        }
    }

    /// The request's own ceiling, as a real deadline.
    ///
    /// `URLRequest.timeoutInterval` is an idle timer: it measures the gap
    /// between bytes, so a server that dribbles never trips it and the engine's
    /// in-flight guard latches permanently, which is the exact failure chapter
    /// 00 §0.6 makes the ceiling mandatory to prevent.
    private func armDeadline(for task: URLSessionTask, timeoutMs: UInt64) {
        let identifier = task.taskIdentifier
        let deadline = DispatchWorkItem { [weak self] in
            guard let self else { return }
            let fired = exchanges.withLock { table -> Bool in
                guard let exchange = table[identifier] else { return false }
                exchange.deadlineExceeded = true
                return true
            }
            guard fired else { return }
            // Cancelling is the only way to stop a `URLSessionTask`; the
            // `deadlineExceeded` flag above is what turns the resulting
            // `URLError.cancelled` back into `Timeout` rather than `Cancelled`.
            task.cancel()
        }
        exchanges.withLock { $0[identifier]?.deadline = deadline }
        DispatchQueue.global(qos: .utility).asyncAfter(
            deadline: .now() + .milliseconds(Int(min(timeoutMs, UInt64(Int.max)))),
            execute: deadline
        )
    }

    // MARK: - URLSessionDataDelegate

    func urlSession(
        _ session: URLSession,
        dataTask: URLSessionDataTask,
        didReceive response: URLResponse,
        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
    ) {
        exchanges.withLock { $0[dataTask.taskIdentifier]?.response = response as? HTTPURLResponse }
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        exchanges.withLock { $0[dataTask.taskIdentifier]?.body.append(data) }
    }

    /// **Redirects are not followed.** A redirect is a second request, and this
    /// seam makes one; handing the 3xx to the core as a response keeps the
    /// decision where every other protocol decision lives, and stops a bearer
    /// token being replayed to whatever host a `Location` names.
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: (any Error)?) {
        let finished: (exchange: HTTPExchange, continuation: CheckedContinuation<HttpResponse, any Error>)?
        finished = exchanges.withLock { table in
            guard let exchange = table[task.taskIdentifier], let continuation = exchange.detach() else {
                table[task.taskIdentifier] = nil
                return nil
            }
            table[task.taskIdentifier] = nil
            return (exchange, continuation)
        }
        guard let finished else { return }
        finished.exchange.deadline?.cancel()

        if let error {
            finished.exchange.body.discard()
            let mapped = TransportErrorMapping.map(
                error,
                elapsedMs: URLSessionTransport.elapsedMs(since: finished.exchange.startedAt),
                deadlineExceeded: finished.exchange.deadlineExceeded
            )
            finished.continuation.resume(throwing: mapped)
            return
        }

        do {
            finished.continuation.resume(returning: try Self.response(of: finished.exchange))
        } catch {
            finished.exchange.body.discard()
            finished.continuation.resume(throwing: error)
        }
    }

    /// The success path, and the one place "could not tell" must not become
    /// "nothing there": a body this seam failed to buffer is thrown, never
    /// returned short or empty. An empty body reaching an applier is a content
    /// wipe (chapter 04 §4.1 is the precedent).
    private static func response(of exchange: HTTPExchange) throws -> HttpResponse {
        guard let http = exchange.response else {
            // A completion with no HTTP response is not a 0-status answer; it
            // is no answer.
            throw TransportError.Failed(what: "the response was not HTTP")
        }
        var headers: [String: String] = [:]
        for (name, value) in http.allHeaderFields {
            guard let name = name as? String, let value = value as? String else { continue }
            // Lowercase in both directions, from the contract. `URLSession`
            // makes no promise about response-header casing, and chapter 00
            // §0.6 reads `retry-after` from a 429 in lowercase — so a server
            // answering `Retry-After` must still reach the core as
            // `retry-after`.
            headers[name.lowercased()] = value
        }
        return HttpResponse(
            status: UInt16(clamping: http.statusCode),
            headers: headers,
            body: try exchange.body.finish()
        )
    }
}

/// One in-flight exchange. Every field is touched only under the collector's
/// lock, which is why this is a plain class rather than a second lock.
final class HTTPExchange: @unchecked Sendable {
    let startedAt = DispatchTime.now()
    let body: ResponseBodyBuffer
    var response: HTTPURLResponse?
    var deadline: DispatchWorkItem?
    var deadlineExceeded = false

    private var continuation: CheckedContinuation<HttpResponse, any Error>?

    init(body: ResponseBodyBuffer) {
        self.body = body
    }

    func attach(_ continuation: CheckedContinuation<HttpResponse, any Error>) {
        self.continuation = continuation
    }

    /// Takes the continuation, leaving none behind, so a completion delivered
    /// twice cannot resume it twice.
    func detach() -> CheckedContinuation<HttpResponse, any Error>? {
        defer { continuation = nil }
        return continuation
    }
}

/// One response body, held in memory until it is big enough to be worth a file.
///
/// R5: large blob fetches should not come back as one contiguous buffer. Past
/// the threshold this streams to a file and hands the core a **memory-mapped**
/// `Data`, so the bytes exist once — as pages the kernel can evict — rather
/// than twice as a resident buffer that grows by reallocation.
///
/// **The file is unlinked as soon as it is mapped.** An unlinked file keeps its
/// mapping alive on Darwin, so the core still reads every byte while nothing is
/// left on disk to leak an attachment's plaintext-at-rest or to survive a
/// crash.
final class ResponseBodyBuffer {
    private let thresholdBytes: Int
    private let directory: URL
    private var resident = Data()
    private var spillURL: URL?
    private var handle: FileHandle?
    private var failure: String?

    private(set) var byteCount = 0
    /// Whether this body was streamed to a file. Read by tests; the core is
    /// told nothing about it, because the seam's answer is the same either way.
    private(set) var didSpill = false

    init(thresholdBytes: Int, directory: URL) {
        self.thresholdBytes = thresholdBytes
        self.directory = directory
    }

    func append(_ chunk: Data) {
        guard failure == nil, !chunk.isEmpty else { return }
        byteCount += chunk.count

        if !didSpill, resident.count + chunk.count <= thresholdBytes {
            resident.append(chunk)
            return
        }
        if !didSpill { beginSpill() }
        guard let handle else { return }
        do {
            try handle.write(contentsOf: chunk)
        } catch {
            // Recorded, never swallowed: `finish()` throws rather than
            // returning the part that made it.
            failure = "the response body could not be buffered"
        }
    }

    /// Throws when any byte of the body was lost. A short body is not a body.
    func finish() throws -> Data {
        if let failure {
            discard()
            throw TransportError.Failed(what: failure)
        }
        guard didSpill, let spillURL else { return resident }

        do {
            try handle?.close()
            handle = nil
            let mapped = try Data(contentsOf: spillURL, options: .mappedIfSafe)
            try? FileManager.default.removeItem(at: spillURL)
            self.spillURL = nil
            guard mapped.count == byteCount else {
                throw TransportError.Failed(what: "the response body was truncated on disk")
            }
            return mapped
        } catch let error as TransportError {
            throw error
        } catch {
            discard()
            throw TransportError.Failed(what: "the response body could not be read back")
        }
    }

    /// Drops whatever was collected and leaves nothing on disk. Called on every
    /// failure path, because a cancelled attachment fetch must not leave a
    /// half-file behind.
    func discard() {
        try? handle?.close()
        handle = nil
        resident = Data()
        if let spillURL {
            try? FileManager.default.removeItem(at: spillURL)
        }
        spillURL = nil
    }

    private func beginSpill() {
        let url = directory.appendingPathComponent("memry-transport-\(UUID().uuidString)")
        guard FileManager.default.createFile(atPath: url.path, contents: nil) else {
            failure = "the response body spill file could not be created"
            return
        }
        do {
            let opened = try FileHandle(forWritingTo: url)
            try opened.write(contentsOf: resident)
            handle = opened
            spillURL = url
            didSpill = true
            resident = Data()
        } catch {
            try? FileManager.default.removeItem(at: url)
            failure = "the response body could not be spilled to disk"
        }
    }
}
