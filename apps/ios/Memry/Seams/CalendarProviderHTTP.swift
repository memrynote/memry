import Foundation

// Spec 007 CL071-CL074. The calendar providers' requests: subscribed feeds
// (ICS GET), CalDAV (WebDAV) and Google Calendar's REST API with its OAuth
// token endpoint. They go to the user's own calendar servers, never to
// Memry's, and carry the user's provider credentials, so they are not the
// core's `Transport`; they live here so every network path in the shell stays
// in this folder (`scripts/check-architecture-boundaries.js`). Constitution I
// still holds: the core never opens a socket, the shell hands it bodies.

enum CalendarProviderHTTP {
    struct Response: Sendable {
        let status: Int
        let headers: [String: String]
        let body: Data
        let url: URL?

        func header(_ name: String) -> String? {
            headers.first { $0.key.caseInsensitiveCompare(name) == .orderedSame }?.value
        }
    }

    enum Failure: Error, Equatable {
        case timeout
        case unreachable
    }

    /// One request. Redirects are not followed, so a caller that must count
    /// or vet each hop (ICS: five http(s) hops) sees every 3xx.
    static func send(_ request: URLRequest, timeout: TimeInterval = 30) async throws -> Response {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = timeout
        configuration.timeoutIntervalForResource = timeout
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.httpShouldSetCookies = false
        let session = URLSession(configuration: configuration, delegate: NoRedirects(), delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else { throw Failure.unreachable }
            var headers: [String: String] = [:]
            for (key, value) in http.allHeaderFields {
                if let key = key as? String, let value = value as? String { headers[key] = value }
            }
            return Response(status: http.statusCode, headers: headers, body: data, url: http.url)
        } catch let error as URLError where error.code == .timedOut {
            throw Failure.timeout
        } catch let failure as Failure {
            throw failure
        } catch {
            let code = (error as? URLError)?.code.rawValue ?? -1
            Log.sync.error("a calendar provider request failed", .count(code))
            throw Failure.unreachable
        }
    }
}

private final class NoRedirects: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest
    ) async -> URLRequest? {
        nil
    }
}
