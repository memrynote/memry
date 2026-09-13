import Foundation
import MemryCore

/// The `Transport` seam over `URLSession` — the S2 subject.
///
/// Deliberately dumb (`contracts/shell-seams.md`): one request in, status plus
/// lowercase headers plus bytes out. No retry, no backoff, no token handling,
/// no opinion about the path. Everything else is the core's.
final class SpikeURLSessionTransport: Transport, @unchecked Sendable {
    private let lock = NSLock()
    private var sent: [String] = []
    private let log: SpikeObservationLog
    /// When set, every request is cancelled after this many milliseconds, which
    /// is how the spike reaches `TransportError.Cancelled` from a call the core
    /// issued rather than from one the shell made up.
    private let cancelAfterMs: Int?

    init(log: SpikeObservationLog, cancelAfterMs: Int? = nil) {
        self.log = log
        self.cancelAfterMs = cancelAfterMs
    }

    var sentUrls: [String] {
        lock.lock()
        defer { lock.unlock() }
        return sent
    }

    func send(request: HttpRequest) async throws -> HttpResponse {
        log.record(SpikeCallbackObservation(seam: "Transport", method: "send(\(request.method) \(request.url))"))
        lock.withLock { sent.append(request.url) }

        guard let url = URL(string: request.url) else {
            throw TransportError.Failed(what: "unparseable url \(request.url)")
        }
        var urlRequest = URLRequest(url: url)
        urlRequest.httpMethod = request.method
        urlRequest.httpBody = request.body
        urlRequest.timeoutInterval = TimeInterval(request.timeoutMs) / 1000
        for (name, value) in request.headers {
            urlRequest.setValue(value, forHTTPHeaderField: name)
        }

        let started = Date()
        let work = Task { try await URLSession.shared.data(for: urlRequest) }
        if let cancelAfterMs {
            Task {
                try? await Task.sleep(for: .milliseconds(cancelAfterMs))
                work.cancel()
            }
        }
        do {
            let (data, response) = try await work.value
            guard let http = response as? HTTPURLResponse else {
                throw TransportError.Failed(what: "response was not HTTP")
            }
            var headers: [String: String] = [:]
            for (name, value) in http.allHeaderFields {
                guard let name = name as? String, let value = value as? String else { continue }
                headers[name.lowercased()] = value
            }
            return HttpResponse(status: UInt16(http.statusCode), headers: headers, body: data)
        } catch let error as TransportError {
            throw error
        } catch {
            throw Self.map(error, elapsedMs: UInt64(Date().timeIntervalSince(started) * 1000))
        }
    }

    func openSocket(request: SocketRequest, listener: SocketListener) throws -> SocketHandle {
        throw TransportError.Failed(what: "S2 covers send() only; the socket is a separate task")
    }

    /// The mapping is the seam's whole contract: collapsing `Cancelled` into
    /// `Failed` charges a user's own cancel against the retry budget, and
    /// collapsing a TLS refusal into `Failed` retries a certificate failure.
    static func map(_ error: Error, elapsedMs: UInt64) -> TransportError {
        guard let urlError = error as? URLError else {
            if error is CancellationError { return .Cancelled }
            return .Failed(what: String(describing: error))
        }
        switch urlError.code {
        case .cancelled:
            return .Cancelled
        case .timedOut:
            return .Timeout(elapsedMs: elapsedMs)
        case .notConnectedToInternet, .networkConnectionLost, .dataNotAllowed, .cannotConnectToHost:
            return .Offline
        case .secureConnectionFailed, .serverCertificateUntrusted, .serverCertificateHasBadDate,
             .serverCertificateHasUnknownRoot, .serverCertificateNotYetValid,
             .clientCertificateRejected, .clientCertificateRequired, .appTransportSecurityRequiresSecureConnection:
            return .Tls(what: urlError.localizedDescription)
        default:
            return .Failed(what: "URLError \(urlError.code.rawValue): \(urlError.localizedDescription)")
        }
    }
}
