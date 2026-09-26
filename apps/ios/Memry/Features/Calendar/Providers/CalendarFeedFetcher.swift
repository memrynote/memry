import Foundation
import MemryCore

// Spec 007 CL073. The HTTP half of subscribed calendars (desktop
// `ics/ics-fetch.ts`): a conditional GET with desktop's limits (30 s, 20 MB,
// five http(s) redirects), its error codes, and the zones a feed names
// resolved from this iPhone's time zone database. The core parses, expands
// and mirrors (`VaultCalendar.feed*`).

enum CalendarFeedFetch: Equatable {
    case body(CalendarFetchedFeed)
    case notModified
    /// An `IcsFeedErrorCode`.
    case failed(String)
}

struct CalendarFeedFetcher: Sendable {
    static let timeout: TimeInterval = 30
    static let maxBytes = 20 * 1024 * 1024
    static let maxRedirects = 5

    /// GETs `url` (already normalised), sending the validators of this
    /// device's last response.
    func fetch(_ url: String, etag: String?, lastModified: String?) async -> CalendarFeedFetch {
        guard var current = URL(string: url) else { return .failed("invalid_url") }
        for _ in 0 ... Self.maxRedirects {
            var request = URLRequest(url: current, timeoutInterval: Self.timeout)
            request.setValue("text/calendar, text/plain;q=0.9, */*;q=0.1", forHTTPHeaderField: "Accept")
            if let etag { request.setValue(etag, forHTTPHeaderField: "If-None-Match") }
            if let lastModified { request.setValue(lastModified, forHTTPHeaderField: "If-Modified-Since") }
            let response: CalendarProviderHTTP.Response
            do {
                response = try await CalendarProviderHTTP.send(request, timeout: Self.timeout)
            } catch CalendarProviderHTTP.Failure.timeout {
                return .failed("timeout")
            } catch {
                return .failed("unreachable")
            }
            switch response.status {
            case 301, 302, 303, 307, 308:
                guard let location = response.header("Location"),
                      let next = URL(string: location, relativeTo: current)?.absoluteURL
                else { return .failed("http_error") }
                guard next.scheme == "https" || next.scheme == "http" else { return .failed("unsupported_redirect") }
                current = next
                continue
            case 304:
                return .notModified
            case 401, 403:
                return .failed("unauthorized")
            case 404, 410:
                return .failed("not_found")
            case 200 ..< 300:
                if response.body.count > Self.maxBytes { return .failed("too_large") }
                guard let text = String(data: response.body, encoding: .utf8) ?? String(data: response.body, encoding: .isoLatin1) else {
                    return .failed("not_a_calendar")
                }
                return .body(CalendarFetchedFeed(text: text, etag: response.header("ETag"), lastModified: response.header("Last-Modified")))
            default:
                return .failed("http_error")
            }
        }
        return .failed("too_many_redirects")
    }

    /// The IANA zones the feed names, over the mirror's window, and this
    /// iPhone's own. Names the database does not know stay out: the core
    /// reads those as floating time, as desktop does.
    static func zones(for text: String, now: Date = Date()) -> CalendarFeedZones {
        let from = now.addingTimeInterval(-400 * 86_400)
        let to = now.addingTimeInterval(800 * 86_400)
        let named = calendarFeedZoneIds(text: text).compactMap { id -> CalendarZone? in
            guard let zone = TimeZone(identifier: id) else { return nil }
            var table = CalendarDates.zone(from: from, to: to, timeZone: zone)
            table.identifier = id
            return table
        }
        return CalendarFeedZones(named: named, local: CalendarDates.zone(from: from, to: to))
    }
}
