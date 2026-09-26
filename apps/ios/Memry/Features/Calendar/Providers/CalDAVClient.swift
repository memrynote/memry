import Foundation
import MemryCore

// Spec 007 CL074. CalDAV over WebDAV (RFC 4791, RFC 6578), what desktop's
// `caldav/caldav-client.ts` does through tsdav: discovery (principal,
// calendar home, the calendars that hold events), a window query, a
// sync-collection delta, a multiget, and PUT / DELETE with ETags. The
// requests go through `CalendarProviderHTTP` (Seams/); the core applies the
// answers.

struct CalDAVCredentials: Sendable, Equatable {
    let username: String
    let password: String

    var header: String {
        "Basic " + Data("\(username):\(password)".utf8).base64EncodedString()
    }
}

struct CalDAVDiscovery: Sendable, Equatable {
    let serverUrl: String
    let principalUrl: String
    let homeUrl: String
    let calendars: [CalendarCaldavCalendar]
}

enum CalDAVError: Error, Equatable {
    /// `CaldavConnectErrorCode`: `unauthorized`, `unreachable`, `not_caldav`,
    /// `no_calendars`; pulls also `conflict` (412), `gone` (404 on a write).
    case code(String)

    var code: String {
        if case let .code(code) = self { return code }
        return "unreachable"
    }
}

struct CalDAVClient: Sendable {
    let credentials: CalDAVCredentials

    // MARK: Requests

    private func request(_ url: URL, method: String, depth: String? = nil, body: String? = nil, headers: [String: String] = [:]) async throws -> CalendarProviderHTTP.Response {
        var current = url
        for _ in 0 ..< 5 {
            var request = URLRequest(url: current, timeoutInterval: 30)
            request.httpMethod = method
            request.setValue(credentials.header, forHTTPHeaderField: "Authorization")
            if let depth { request.setValue(depth, forHTTPHeaderField: "Depth") }
            if let body {
                request.httpBody = Data(body.utf8)
                request.setValue(method == "PUT" ? "text/calendar; charset=utf-8" : "application/xml; charset=utf-8", forHTTPHeaderField: "Content-Type")
            }
            for (key, value) in headers { request.setValue(value, forHTTPHeaderField: key) }
            let response: CalendarProviderHTTP.Response
            do {
                response = try await CalendarProviderHTTP.send(request)
            } catch {
                Log.sync.error("a CalDAV request did not answer", .code("caldav.unreachable"))
                throw CalDAVError.code("unreachable")
            }
            Log.sync.info("a CalDAV request answered", .count(response.status))
            // Discovery starts at `/.well-known/caldav`, which redirects.
            if [301, 302, 307, 308].contains(response.status), let location = response.header("Location"),
               let next = URL(string: location, relativeTo: current)?.absoluteURL {
                current = next
                continue
            }
            if response.status == 401 || response.status == 403 { throw CalDAVError.code("unauthorized") }
            return response
        }
        throw CalDAVError.code("unreachable")
    }

    private func multistatus(_ url: URL, method: String, depth: String, body: String) async throws -> [DAVResponse] {
        let response = try await request(url, method: method, depth: depth, body: body)
        guard response.status == 207 else {
            throw CalDAVError.code(response.status == 404 || response.status == 405 ? "not_caldav" : "unreachable")
        }
        return DAVMultistatus.parse(response.body, base: response.url ?? url)
    }

    // MARK: Discovery

    /// `discoverCaldavAccount`.
    func discover(serverUrl: String) async throws -> CalDAVDiscovery {
        guard let server = URL(string: serverUrl) else { throw CalDAVError.code("invalid_url") }
        let principalBody = #"<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>"#
        var principal: URL?
        for candidate in [server, URL(string: "/.well-known/caldav", relativeTo: server)?.absoluteURL].compactMap({ $0 }) {
            if let found = try? await multistatus(candidate, method: "PROPFIND", depth: "0", body: principalBody)
                .compactMap({ $0.hrefs["current-user-principal"]?.first }).first {
                principal = found
                break
            }
        }
        guard let principal else { throw CalDAVError.code("not_caldav") }
        let homeBody = #"<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-home-set/></d:prop></d:propfind>"#
        guard let home = try await multistatus(principal, method: "PROPFIND", depth: "0", body: homeBody)
            .compactMap({ $0.hrefs["calendar-home-set"]?.first }).first
        else { throw CalDAVError.code("not_caldav") }
        let listBody = """
        <?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:a="http://apple.com/ns/ical/"><d:prop><d:displayname/><d:resourcetype/><cs:getctag/><d:sync-token/><a:calendar-color/><c:calendar-timezone/><c:supported-calendar-component-set/><d:supported-report-set/></d:prop></d:propfind>
        """
        let responses = try await multistatus(home, method: "PROPFIND", depth: "1", body: listBody)
        let calendars: [CalendarCaldavCalendar] = responses.compactMap { response in
            guard response.children["resourcetype"]?.contains("calendar") == true else { return nil }
            let components = response.attributes["supported-calendar-component-set"] ?? []
            if !components.isEmpty, !components.contains("VEVENT") { return nil }
            let url = response.href.absoluteString
            let name = response.text["displayname"]?.trimmingCharacters(in: .whitespacesAndNewlines)
            let fallback = response.href.pathComponents.last(where: { $0 != "/" }) ?? url
            let reports = response.children["supported-report-set"] ?? []
            return CalendarCaldavCalendar(
                url: url,
                displayName: (name?.isEmpty == false ? name : nil) ?? fallback,
                color: Self.color(response.text["calendar-color"]),
                timezone: response.text["calendar-timezone"].flatMap(Self.tzid),
                supportsSyncCollection: reports.contains("sync-collection") || response.text["sync-token"] != nil
            )
        }
        if calendars.isEmpty { throw CalDAVError.code("no_calendars") }
        return CalDAVDiscovery(serverUrl: serverUrl, principalUrl: principal.absoluteString, homeUrl: home.absoluteString, calendars: calendars)
    }

    /// `#RRGGBB` from `#RRGGBBAA` or `#RGB`.
    static func color(_ raw: String?) -> String? {
        guard var hex = raw?.trimmingCharacters(in: .whitespacesAndNewlines), hex.hasPrefix("#") else { return nil }
        hex.removeFirst()
        if hex.count == 3 { hex = hex.map { "\($0)\($0)" }.joined() }
        guard hex.count >= 6 else { return nil }
        return "#" + hex.prefix(6).lowercased()
    }

    static func tzid(_ vcalendar: String) -> String? {
        vcalendar.split(whereSeparator: \.isNewline).first { $0.uppercased().hasPrefix("TZID:") }
            .map { String($0.dropFirst(5)).trimmingCharacters(in: .whitespaces) }
    }

    // MARK: Pull

    /// `queryObjectsInWindow`: every object touching [start, end] with data.
    func objects(in calendar: URL, start: Date, end: Date) async throws -> [CalendarCaldavObject] {
        let body = """
        <?xml version="1.0"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="\(Self.stamp(start))" end="\(Self.stamp(end))"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>
        """
        return try await multistatus(calendar, method: "REPORT", depth: "1", body: body).compactMap(Self.object)
    }

    /// `syncCollectionChanges`: changed hrefs (fetched with a multiget),
    /// removed hrefs, the next token. `nil` when the token is no longer
    /// valid (the caller starts over with a window query).
    func changes(in calendar: URL, token: String) async throws -> (objects: [CalendarCaldavObject], removed: [String], token: String?)? {
        let body = """
        <?xml version="1.0"?><d:sync-collection xmlns:d="DAV:"><d:sync-token>\(Self.escape(token))</d:sync-token><d:sync-level>1</d:sync-level><d:prop><d:getetag/></d:prop></d:sync-collection>
        """
        let response = try await request(calendar, method: "REPORT", depth: "1", body: body)
        if response.status == 403 || response.status == 409 || response.status == 412 { return nil }
        guard response.status == 207 else { throw CalDAVError.code("unreachable") }
        let responses = DAVMultistatus.parse(response.body, base: response.url ?? calendar)
        let removed = responses.filter { $0.status == 404 }.map(\.href.absoluteString)
        let changed = responses.filter { $0.status != 404 && !$0.href.absoluteString.hasSuffix("/") }.map(\.href)
        let objects = changed.isEmpty ? [] : try await multiget(calendar, hrefs: changed)
        return (objects, removed, DAVMultistatus.syncToken(response.body))
    }

    func multiget(_ calendar: URL, hrefs: [URL]) async throws -> [CalendarCaldavObject] {
        let list = hrefs.map { "<d:href>\(Self.escape($0.path))</d:href>" }.joined()
        let body = """
        <?xml version="1.0"?><c:calendar-multiget xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/></d:prop>\(list)</c:calendar-multiget>
        """
        return try await multistatus(calendar, method: "REPORT", depth: "1", body: body).compactMap(Self.object)
    }

    /// The collection's sync token and ctag.
    func state(of calendar: URL) async throws -> (token: String?, ctag: String?) {
        let body = #"<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/"><d:prop><d:sync-token/><cs:getctag/></d:prop></d:propfind>"#
        let response = try await multistatus(calendar, method: "PROPFIND", depth: "0", body: body).first
        return (response?.text["sync-token"], response?.text["getctag"])
    }

    // MARK: Write

    /// PUT; returns the ETag (read back when the server rewrote the object).
    func put(_ href: URL, ics: String, ifMatch: String?) async throws -> String? {
        var headers: [String: String] = [:]
        if let ifMatch { headers["If-Match"] = ifMatch } else { headers["If-None-Match"] = "*" }
        let response = try await request(href, method: "PUT", body: ics, headers: headers)
        switch response.status {
        case 200 ..< 300:
            if let etag = response.header("ETag") { return etag }
            let body = #"<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getetag/></d:prop></d:propfind>"#
            return try? await multistatus(href, method: "PROPFIND", depth: "0", body: body).first?.text["getetag"]
        case 412: throw CalDAVError.code("conflict")
        case 404, 410: throw CalDAVError.code("gone")
        default: throw CalDAVError.code("unreachable")
        }
    }

    /// One object as the server holds it now (`getObject`).
    func object(at href: URL) async throws -> CalendarCaldavObject {
        let response = try await request(href, method: "GET")
        switch response.status {
        case 200 ..< 300:
            return CalendarCaldavObject(href: href.absoluteString, etag: response.header("ETag"), data: String(decoding: response.body, as: UTF8.self))
        case 404, 410: throw CalDAVError.code("gone")
        default: throw CalDAVError.code("unreachable")
        }
    }

    func delete(_ href: URL, ifMatch: String?) async throws {
        var headers: [String: String] = [:]
        if let ifMatch { headers["If-Match"] = ifMatch }
        let response = try await request(href, method: "DELETE", headers: headers)
        switch response.status {
        case 200 ..< 300, 404, 410: return
        case 412: throw CalDAVError.code("conflict")
        default: throw CalDAVError.code("unreachable")
        }
    }

    // MARK: Helpers

    private static func object(_ response: DAVResponse) -> CalendarCaldavObject? {
        guard response.status != 404, let data = response.text["calendar-data"], !data.isEmpty else { return nil }
        return CalendarCaldavObject(href: response.href.absoluteString, etag: response.text["getetag"], data: data)
    }

    static func stamp(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.dateFormat = "yyyyMMdd'T'HHmmss'Z'"
        return formatter.string(from: date)
    }

    static func escape(_ text: String) -> String {
        text.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;")
    }
}

/// One `<d:response>` of a multistatus: its href (absolute), status, each
/// property's text, the child element names of container properties
/// (`resourcetype`, `supported-report-set`), hrefs nested in a property
/// (`current-user-principal`, `calendar-home-set`) and `comp name=` values.
struct DAVResponse: Sendable {
    var href: URL
    var status = 200
    var text: [String: String] = [:]
    var children: [String: [String]] = [:]
    var hrefs: [String: [URL]] = [:]
    var attributes: [String: [String]] = [:]
}

final class DAVMultistatus: NSObject, XMLParserDelegate {
    private let base: URL
    private var responses: [DAVResponse] = []
    private var current: DAVResponse?
    private var path: [String] = []
    private var buffer = ""
    private var propstatStatus = 200
    private var pending: [String: String] = [:]
    private var pendingChildren: [String: [String]] = [:]
    private var pendingHrefs: [String: [URL]] = [:]
    private var pendingAttributes: [String: [String]] = [:]
    private var token: String?

    private init(base: URL) { self.base = base }

    static func parse(_ data: Data, base: URL) -> [DAVResponse] {
        let delegate = DAVMultistatus(base: base)
        let parser = XMLParser(data: data)
        parser.shouldProcessNamespaces = true
        parser.delegate = delegate
        parser.parse()
        return delegate.responses
    }

    static func syncToken(_ data: Data) -> String? {
        let delegate = DAVMultistatus(base: URL(fileURLWithPath: "/"))
        let parser = XMLParser(data: data)
        parser.shouldProcessNamespaces = true
        parser.delegate = delegate
        parser.parse()
        return delegate.token
    }

    /// The property a node sits under: the element right below `prop`.
    private var property: String? {
        guard let index = path.lastIndex(of: "prop"), index + 1 < path.count else { return nil }
        return path[index + 1]
    }

    func parser(_ parser: XMLParser, didStartElement elementName: String, namespaceURI: String?, qualifiedName: String?, attributes: [String: String] = [:]) {
        path.append(elementName)
        buffer = ""
        switch elementName {
        case "response": current = DAVResponse(href: base)
        case "propstat":
            propstatStatus = 200
            pending = [:]; pendingChildren = [:]; pendingHrefs = [:]; pendingAttributes = [:]
        default:
            if let property, property != elementName {
                pendingChildren[property, default: []].append(elementName)
                if let name = attributes["name"] { pendingAttributes[property, default: []].append(name) }
            }
        }
    }

    func parser(_ parser: XMLParser, foundCharacters string: String) { buffer += string }

    func parser(_ parser: XMLParser, foundCDATA CDATABlock: Data) { buffer += String(decoding: CDATABlock, as: UTF8.self) }

    func parser(_ parser: XMLParser, didEndElement elementName: String, namespaceURI: String?, qualifiedName: String?) {
        let text = buffer
        defer { _ = path.popLast(); buffer = "" }
        let parent = path.count >= 2 ? path[path.count - 2] : ""
        switch elementName {
        case "href":
            let url = URL(string: text.trimmingCharacters(in: .whitespacesAndNewlines), relativeTo: base)?.absoluteURL
            if parent == "response", let url {
                current?.href = url
            } else if let property, let url {
                pendingHrefs[property, default: []].append(url)
            }
        case "status":
            let code = text.split(separator: " ").dropFirst().first.flatMap { Int($0) } ?? 200
            if parent == "propstat" { propstatStatus = code } else if parent == "response" { current?.status = code }
        case "propstat":
            if (200 ..< 300).contains(propstatStatus) {
                current?.text.merge(pending) { $1 }
                current?.children.merge(pendingChildren) { $0 + $1 }
                current?.hrefs.merge(pendingHrefs) { $0 + $1 }
                current?.attributes.merge(pendingAttributes) { $0 + $1 }
            }
        case "response":
            if let current { responses.append(current) }
            current = nil
        case "sync-token" where parent == "multistatus":
            token = text.trimmingCharacters(in: .whitespacesAndNewlines)
        default:
            if parent == "prop" {
                pending[elementName] = text.trimmingCharacters(in: elementName == "calendar-data" ? [] : .whitespacesAndNewlines)
            }
        }
    }
}
