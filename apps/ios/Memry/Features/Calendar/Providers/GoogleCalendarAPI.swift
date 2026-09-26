import AuthenticationServices
import Foundation
import MemryCore

// Spec 007 CL071. Google Calendar on this iPhone. It signs in itself with the
// iOS OAuth client (§6 CL003: a desktop refresh token is bound to desktop's
// client and cannot be refreshed here): authorization code + PKCE through
// `ASWebAuthenticationSession`, scopes `openid email calendar`, the tokens in
// this iPhone's Keychain (`CalendarProviderSecrets`). Requests go through
// `CalendarProviderHTTP` (Seams/); the core maps and applies.

struct GoogleCalendarAPI: Sendable {
    static let calendarScope = "https://www.googleapis.com/auth/calendar"
    static let base = "https://www.googleapis.com/calendar/v3"

    let email: String
    let secrets: CalendarProviderSecrets

    enum Failure: Error, Equatable {
        case reconnectRequired
        case gone
        case http(Int)
        case unreadable
    }

    // MARK: Tokens

    /// A current access token, refreshed when it is within a minute of
    /// expiry. A refresh Google refuses (`invalid_grant`) means the account
    /// needs a new sign-in on this iPhone.
    func accessToken() async throws -> String {
        guard var tokens = secrets.googleTokens(email) else { throw Failure.reconnectRequired }
        if tokens.expiresAt.timeIntervalSinceNow > 60 { return tokens.accessToken }
        let configuration = try GoogleSignInConfiguration.fromBundle()
        let body = [
            "grant_type=refresh_token",
            "client_id=\(configuration.clientID)",
            "refresh_token=\(Self.formEncode(tokens.refreshToken))"
        ].joined(separator: "&")
        guard let url = URL(string: GoogleSignInConfiguration.tokenEndpoint) else { throw Failure.unreadable }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.httpBody = Data(body.utf8)
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        let response = try await CalendarProviderHTTP.send(request)
        guard response.status == 200 else {
            if response.status == 400 || response.status == 401 { throw Failure.reconnectRequired }
            throw Failure.http(response.status)
        }
        guard let object = try? JSONSerialization.jsonObject(with: response.body) as? [String: Any],
              let access = object["access_token"] as? String else { throw Failure.unreadable }
        tokens.accessToken = access
        tokens.expiresAt = Date().addingTimeInterval(TimeInterval((object["expires_in"] as? Int) ?? 3_600))
        _ = secrets.setGoogleTokens(email, tokens)
        return access
    }

    private func call(_ method: String, _ path: String, query: [URLQueryItem] = [], body: String? = nil, ifMatch: String? = nil) async throws -> CalendarProviderHTTP.Response {
        guard var components = URLComponents(string: Self.base + path) else { throw Failure.unreadable }
        if !query.isEmpty { components.queryItems = query }
        guard let url = components.url else { throw Failure.unreadable }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("Bearer \(try await accessToken())", forHTTPHeaderField: "Authorization")
        if let body {
            request.httpBody = Data(body.utf8)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        if let ifMatch { request.setValue(ifMatch, forHTTPHeaderField: "If-Match") }
        let response = try await CalendarProviderHTTP.send(request)
        switch response.status {
        case 200 ..< 300: return response
        case 401: throw Failure.reconnectRequired
        case 404, 410: throw Failure.gone
        default: throw Failure.http(response.status)
        }
    }

    private static func path(_ id: String) -> String {
        id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/@#"))) ?? id
    }

    static func formEncode(_ text: String) -> String {
        text.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-._~"))) ?? text
    }

    // MARK: Calls

    /// `calendarList.list`.
    func calendars() async throws -> [CalendarGoogleCalendar] {
        let response = try await call("GET", "/users/me/calendarList")
        guard let object = try? JSONSerialization.jsonObject(with: response.body) as? [String: Any],
              let items = object["items"] as? [[String: Any]] else { throw Failure.unreadable }
        return items.compactMap { item in
            guard let id = item["id"] as? String else { return nil }
            return CalendarGoogleCalendar(
                id: id, title: item["summary"] as? String ?? id, timezone: item["timeZone"] as? String,
                color: item["backgroundColor"] as? String, isPrimary: item["primary"] as? Bool ?? false
            )
        }
    }

    /// `events.list` across every page: incremental with a sync token, else
    /// the mirror's window. `nil` events when the token expired (410): the
    /// caller clears the cursor and starts over.
    func events(calendarId: String, syncToken: String?, now: Date) async throws -> (events: String, next: String?)? {
        var all: [Any] = []
        var page: String?
        var next: String?
        for _ in 0 ..< 100 {
            var query = [URLQueryItem(name: "maxResults", value: "250"), URLQueryItem(name: "showDeleted", value: "true")]
            if let syncToken {
                query.append(URLQueryItem(name: "syncToken", value: syncToken))
            } else {
                let formatter = ISO8601DateFormatter()
                query.append(URLQueryItem(name: "timeMin", value: formatter.string(from: now.addingTimeInterval(-90 * 86_400))))
                query.append(URLQueryItem(name: "timeMax", value: formatter.string(from: now.addingTimeInterval(365 * 86_400))))
                query.append(URLQueryItem(name: "singleEvents", value: "true"))
            }
            if let page { query.append(URLQueryItem(name: "pageToken", value: page)) }
            let response: CalendarProviderHTTP.Response
            do {
                response = try await call("GET", "/calendars/\(Self.path(calendarId))/events", query: query)
            } catch Failure.gone where syncToken != nil {
                return nil
            }
            guard let object = try? JSONSerialization.jsonObject(with: response.body) as? [String: Any] else { throw Failure.unreadable }
            all.append(contentsOf: object["items"] as? [Any] ?? [])
            next = object["nextSyncToken"] as? String ?? next
            page = object["nextPageToken"] as? String
            if page == nil { break }
        }
        let data = try JSONSerialization.data(withJSONObject: all)
        return (String(decoding: data, as: UTF8.self), next)
    }

    /// `events.insert` / `events.patch`.
    func upsert(calendarId: String, eventId: String?, body: String) async throws -> (id: String, etag: String?) {
        let path = "/calendars/\(Self.path(calendarId))/events" + (eventId.map { "/\(Self.path($0))" } ?? "")
        let response = try await call(eventId == nil ? "POST" : "PATCH", path, body: body)
        guard let object = try? JSONSerialization.jsonObject(with: response.body) as? [String: Any],
              let id = object["id"] as? String else { throw Failure.unreadable }
        return (id, object["etag"] as? String)
    }

    func delete(calendarId: String, eventId: String) async throws {
        do {
            _ = try await call("DELETE", "/calendars/\(Self.path(calendarId))/events/\(Self.path(eventId))")
        } catch Failure.gone {
            return
        }
    }
}

/// Signing in to Google Calendar on this iPhone.
@MainActor
enum GoogleCalendarSignIn {
    enum Outcome: Equatable {
        case connected(email: String)
        case cancelled
        case failed(String)
    }

    /// The consent sheet, the code exchange, the identity, the tokens.
    static func connect(secrets: CalendarProviderSecrets, authenticator: any GoogleWebAuthenticator = SystemWebAuthenticator()) async -> (Outcome, name: String?) {
        let configuration: GoogleSignInConfiguration
        let request: GoogleAuthorizationRequest
        do {
            configuration = try GoogleSignInConfiguration.fromBundle()
            request = try GoogleAuthorizationRequest(configuration: configuration)
        } catch {
            return (.failed("not_configured"), nil)
        }
        guard var components = URLComponents(string: GoogleSignInConfiguration.authorizationEndpoint) else {
            return (.failed("not_configured"), nil)
        }
        components.queryItems = [
            URLQueryItem(name: "client_id", value: configuration.clientID),
            URLQueryItem(name: "redirect_uri", value: configuration.redirectURI),
            URLQueryItem(name: "response_type", value: "code"),
            URLQueryItem(name: "scope", value: "openid email \(GoogleCalendarAPI.calendarScope)"),
            URLQueryItem(name: "state", value: request.state),
            URLQueryItem(name: "code_challenge", value: request.codeChallenge),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
            URLQueryItem(name: "access_type", value: "offline"),
            URLQueryItem(name: "prompt", value: "consent"),
            URLQueryItem(name: "include_granted_scopes", value: "true")
        ]
        guard let url = components.url else { return (.failed("not_configured"), nil) }
        let callback: URL
        do {
            callback = try await authenticator.authenticate(url: url, callbackURLScheme: configuration.callbackURLScheme)
        } catch let error as ASWebAuthenticationSessionError where error.code == .canceledLogin {
            return (.cancelled, nil)
        } catch {
            return (.failed("browser"), nil)
        }
        let code: String
        do {
            code = try request.authorizationCode(from: callback)
        } catch GoogleSignInFailure.userCancelled {
            return (.cancelled, nil)
        } catch {
            return (.failed("callback"), nil)
        }
        guard let tokenURL = URL(string: GoogleSignInConfiguration.tokenEndpoint) else { return (.failed("not_configured"), nil) }
        var post = URLRequest(url: tokenURL)
        post.httpMethod = "POST"
        post.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        post.httpBody = Data([
            "grant_type=authorization_code",
            "code=\(GoogleCalendarAPI.formEncode(code))",
            "client_id=\(configuration.clientID)",
            "redirect_uri=\(GoogleCalendarAPI.formEncode(configuration.redirectURI))",
            "code_verifier=\(request.codeVerifier)"
        ].joined(separator: "&").utf8)
        guard let response = try? await CalendarProviderHTTP.send(post), response.status == 200,
              let object = try? JSONSerialization.jsonObject(with: response.body) as? [String: Any],
              let access = object["access_token"] as? String else { return (.failed("token_exchange"), nil) }
        let scopes = (object["scope"] as? String ?? "").split(separator: " ").map(String.init)
        guard scopes.contains(GoogleCalendarAPI.calendarScope) else { return (.failed("scope_not_granted"), nil) }
        guard let refresh = object["refresh_token"] as? String else { return (.failed("no_refresh_token"), nil) }
        guard let identity = await userInfo(access) else { return (.failed("userinfo"), nil) }
        let tokens = CalendarProviderSecrets.GoogleTokens(
            accessToken: access, refreshToken: refresh,
            expiresAt: Date().addingTimeInterval(TimeInterval((object["expires_in"] as? Int) ?? 3_600))
        )
        guard secrets.setGoogleTokens(identity.email, tokens) else { return (.failed("keychain"), nil) }
        return (.connected(email: identity.email), identity.name)
    }

    private static func userInfo(_ access: String) async -> (email: String, name: String?)? {
        guard let url = URL(string: "https://www.googleapis.com/oauth2/v2/userinfo") else { return nil }
        var request = URLRequest(url: url)
        request.setValue("Bearer \(access)", forHTTPHeaderField: "Authorization")
        guard let response = try? await CalendarProviderHTTP.send(request), response.status == 200,
              let object = try? JSONSerialization.jsonObject(with: response.body) as? [String: Any],
              let email = object["email"] as? String else { return nil }
        return (email, object["name"] as? String)
    }

    /// `oauth2/revoke`, then the tokens forgotten.
    static func revoke(_ email: String, secrets: CalendarProviderSecrets) async {
        if let tokens = secrets.googleTokens(email), let url = URL(string: "https://oauth2.googleapis.com/revoke") {
            var request = URLRequest(url: url)
            request.httpMethod = "POST"
            request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
            request.httpBody = Data("token=\(GoogleCalendarAPI.formEncode(tokens.refreshToken))".utf8)
            _ = try? await CalendarProviderHTTP.send(request)
        }
        secrets.delete(CalendarProviderSecrets.googleKey(email))
    }
}

extension CalendarStore {
    /// Artboard 24: sign in on this iPhone, then the synced rows and a pull.
    func connectGoogle() async -> GoogleCalendarSignIn.Outcome {
        let (outcome, name) = await GoogleCalendarSignIn.connect(secrets: secrets)
        guard case let .connected(email) = outcome else { return outcome }
        do {
            let calendars = try await GoogleCalendarAPI(email: email, secrets: secrets).calendars()
            guard let primary = calendars.first(where: \.isPrimary) ?? calendars.first else { return .failed("no_calendars") }
            let zoneId = TimeZone.current.identifier
            _ = await write { try $0.googleConnect(email: email, name: name, primary: primary, calendars: calendars, deviceZoneId: zoneId) }
            await sync()
            return outcome
        } catch {
            return .failed("calendar_list")
        }
    }

    func disconnectGoogle(_ email: String) async {
        await GoogleCalendarSignIn.revoke(email, secrets: secrets)
        _ = await write { try $0.googleDisconnect(email: email) }
    }

    /// One shown Google calendar's pull; a 410 starts it over from the window.
    func pullGoogle(_ source: CalendarSourceRecord) async {
        guard let email = source.accountId, holdsGoogle(email) else { return }
        let api = GoogleCalendarAPI(email: email, secrets: secrets)
        do {
            var answer = try await api.events(calendarId: source.remoteId, syncToken: source.syncCursor, now: clock())
            if answer == nil { answer = try await api.events(calendarId: source.remoteId, syncToken: nil, now: clock()) }
            guard let (events, next) = answer else { return }
            // The same zones a push plans with, so a write-back's snapshot
            // matches the next plan (EXDATE lines are written in them).
            let zones = providerZones()
            let core = core
            _ = try await CoreExecutor.shared.run {
                try core.googleApplyPull(sourceId: source.id, calendarId: source.remoteId, eventsJson: events, nextCursor: next, zones: zones)
            }
        } catch {
            Log.sync.error("a Google calendar could not be read", .code("google.pull"))
            let id = source.id, core = core
            _ = try? await CoreExecutor.shared.run { try core.providerSourceError(sourceId: id, error: "pull") }
        }
    }
}
