import Foundation
import MemryCore

// Spec 007 CL070-CL075. Google and CalDAV on this iPhone: connect (the
// credentials stay in this device's Keychain), pull each shown calendar into
// the synced mirror, and push what this device changed to the one provider
// that owns it. Only the device that made a change pushes it (the queue is
// fed by local writes), so two devices holding the same account never write
// the same edit twice.

extension CalendarStore {
    var secrets: CalendarProviderSecrets { CalendarProviderSecrets() }

    // MARK: Accounts on this device

    struct CaldavAccount: Equatable {
        let accountId: String
        let username: String
        let serverUrl: String
        let title: String
    }

    var caldavAccounts: [CaldavAccount] {
        sources.filter { $0.provider == "caldav" && $0.kind == "account" }.compactMap { source in
            guard let accountId = source.accountId,
                  let metadata = source.metadataJson.flatMap({ try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any] }),
                  let server = metadata["serverUrl"] as? String, let username = metadata["username"] as? String
            else { return nil }
            return CaldavAccount(accountId: accountId, username: username, serverUrl: server, title: source.title)
        }
    }

    /// Whether this iPhone holds the account's password.
    func holdsCaldav(_ accountId: String) -> Bool { secrets.caldavPassword(accountId) != nil }

    func holdsGoogle(_ email: String) -> Bool { secrets.googleTokens(email) != nil }

    var googleAccounts: [CalendarSourceRecord] {
        sources.filter { $0.provider == "google" && $0.kind == "account" }
    }

    private var heldProviders: [String] {
        var held: [String] = []
        if caldavAccounts.contains(where: { holdsCaldav($0.accountId) }) { held.append("caldav") }
        if googleAccounts.contains(where: { $0.accountId.map(holdsGoogle) == true }) { held.append("google") }
        return held
    }

    /// The zones a push may need: the device's and every calendar's.
    func providerZones() -> CalendarFeedZones {
        let now = clock()
        let from = now.addingTimeInterval(-400 * 86_400), to = now.addingTimeInterval(800 * 86_400)
        let ids = Set(sources.compactMap(\.timezone))
        let named = ids.compactMap { id -> CalendarZone? in
            guard let zone = TimeZone(identifier: id) else { return nil }
            var table = CalendarDates.zone(from: from, to: to, timeZone: zone)
            table.identifier = id
            return table
        }
        return CalendarFeedZones(named: named, local: CalendarDates.zone(from: from, to: to))
    }

    // MARK: CalDAV connect

    /// Discovery, then the synced rows; the password goes to the Keychain
    /// only after discovery worked. Returns a `CaldavConnectErrorCode`.
    func connectCaldav(server: String, username: String, password: String, preset: String?) async -> String? {
        guard let serverUrl = calendarCaldavNormalizeServer(input: server) else { return "invalid_url" }
        let user = username.trimmingCharacters(in: .whitespaces)
        let client = CalDAVClient(credentials: CalDAVCredentials(username: user, password: password))
        let discovery: CalDAVDiscovery
        do {
            discovery = try await client.discover(serverUrl: serverUrl)
        } catch let error as CalDAVError {
            return error.code
        } catch {
            return "unreachable"
        }
        let accountId = calendarCaldavAccountId(serverUrl: serverUrl, username: user)
        guard secrets.setCaldavPassword(accountId, password) else { return "keychain" }
        let input = CalendarCaldavConnect(
            serverUrl: serverUrl, username: user, principalUrl: discovery.principalUrl, homeUrl: discovery.homeUrl,
            preset: preset, calendars: discovery.calendars, selected: nil
        )
        guard await write({ try $0.caldavConnect(input: input) }) != nil else { return "unreachable" }
        await sync()
        return nil
    }

    func disconnectCaldav(_ accountId: String) async {
        secrets.delete(CalendarProviderSecrets.caldavKey(accountId))
        _ = await write { try $0.caldavDisconnect(accountId: accountId) }
    }

    // MARK: Pull

    /// The pushes this device owes, then every shown Google and CalDAV
    /// calendar it can read (at most every 15 minutes unless `force`,
    /// desktop's CalDAV poll interval). The caller's sync pass carries the
    /// records this writes.
    func syncProviders(force: Bool = true) async {
        await pushPending()
        let due = force || providerPullAt.map { clock().timeIntervalSince($0) > 15 * 60 } ?? true
        if due {
            providerPullAt = clock()
            for source in sources where source.kind == "calendar" && source.isSelected && source.archivedAt == nil {
                switch source.provider {
                case "caldav": await pullCaldav(source)
                case "google": await pullGoogle(source)
                default: break
                }
            }
        }
        await refreshSources()
        await refreshAllWindows()
    }

    private func caldavClient(for source: CalendarSourceRecord) -> CalDAVClient? {
        guard let accountId = source.accountId,
              let account = caldavAccounts.first(where: { $0.accountId == accountId }),
              let password = secrets.caldavPassword(accountId) else { return nil }
        return CalDAVClient(credentials: CalDAVCredentials(username: account.username, password: password))
    }

    private func pullCaldav(_ source: CalendarSourceRecord) async {
        guard let client = caldavClient(for: source), let url = URL(string: source.remoteId) else { return }
        let now = clock()
        do {
            var objects: [CalendarCaldavObject] = []
            var removed: [String] = []
            var full = true
            var cursor: String?
            if let token = source.syncCursor?.stripping("sync-token:"),
               let delta = try await client.changes(in: url, token: token) {
                objects = delta.objects
                removed = delta.removed
                full = false
                cursor = delta.token.map { "sync-token:\($0)" } ?? source.syncCursor
            } else {
                let state = try await client.state(of: url)
                if let ctag = state.ctag, source.syncCursor == "ctag:\(ctag)" {
                    return
                }
                objects = try await client.objects(in: url, start: now.addingTimeInterval(-90 * 86_400), end: now.addingTimeInterval(365 * 86_400))
                cursor = state.token.map { "sync-token:\($0)" } ?? state.ctag.map { "ctag:\($0)" }
            }
            let zones = CalendarFeedFetcher.zones(for: objects.map(\.data).joined(separator: "\n"))
            let (objs, gone, isFull, next) = (objects, removed, full, cursor)
            _ = try await CoreExecutor.shared.run { [core] in
                try core.caldavApplyPull(sourceId: source.id, calendarUrl: source.remoteId, objects: objs, removed: gone, full: isFull, cursor: next, zones: zones)
            }
        } catch {
            Log.sync.error("a CalDAV calendar could not be read", .code("caldav.pull"))
            let id = source.id
            _ = try? await CoreExecutor.shared.run { [core] in try core.providerSourceError(sourceId: id, error: "pull") }
        }
    }

    // MARK: Push

    /// Drains this device's queue: each item's plan, the request, the answer.
    func pushPending() async {
        let core = core
        guard let queue = try? await CoreExecutor.shared.run({ try core.pushQueue() }), !queue.isEmpty else { return }
        let held = heldProviders
        let zones = providerZones()
        for item in queue {
            do {
                guard let first = try await self.plan(for: item, held: held, zones: zones, base: nil) else { continue }
                var planned = first
                if first.action == "fetch" {
                    // Patching needs what the server holds; plan again with it.
                    guard let fetched = try await fetchObject(first),
                          let next = try await self.plan(for: item, held: held, zones: zones, base: fetched) else { continue }
                    planned = next
                }
                let plan = planned
                switch plan.action {
                case "none":
                    try await CoreExecutor.shared.run { try core.pushSkip(sourceType: item.sourceType, sourceId: item.sourceId) }
                case "upsert":
                    let written = try await upsert(plan)
                    try await CoreExecutor.shared.run {
                        try core.pushDone(
                            sourceType: item.sourceType, sourceId: item.sourceId, provider: plan.provider,
                            calendarId: plan.calendarId, remoteEventId: written.id, etag: written.etag, body: plan.body, zones: zones
                        )
                    }
                case "delete", "exclude":
                    if plan.action == "exclude" { _ = try await upsert(plan) } else { try await delete(plan) }
                    try await CoreExecutor.shared.run {
                        try core.pushDeleted(sourceType: item.sourceType, sourceId: item.sourceId, bindingId: plan.bindingId ?? "")
                    }
                default:
                    continue
                }
            } catch {
                let reason = (error as? CalDAVError)?.code ?? "\(error)"
                Log.sync.error("a calendar push failed", .code("calendar.push"))
                _ = try? await CoreExecutor.shared.run { try core.pushFailed(sourceType: item.sourceType, sourceId: item.sourceId, error: reason) }
            }
        }
    }

    private func plan(for item: CalendarPushItem, held: [String], zones: CalendarFeedZones, base: CalendarCaldavObject?) async throws -> CalendarPushPlan? {
        let core = core
        return try await CoreExecutor.shared.run {
            try core.pushPlan(sourceType: item.sourceType, sourceId: item.sourceId, held: held, zones: zones, base: base)
        }
    }

    private func fetchObject(_ plan: CalendarPushPlan) async throws -> CalendarCaldavObject? {
        guard let source = source(forCalendar: plan.calendarId, provider: "caldav"),
              let client = caldavClient(for: source),
              let href = plan.href.flatMap(URL.init(string:)) else { throw CalDAVError.code("unauthorized") }
        return try await client.object(at: href)
    }

    private func source(forCalendar calendarId: String, provider: String) -> CalendarSourceRecord? {
        sources.first { $0.provider == provider && $0.kind == "calendar" && $0.remoteId == calendarId }
    }

    private func upsert(_ plan: CalendarPushPlan) async throws -> (id: String, etag: String?) {
        guard let body = plan.body else { throw CalDAVError.code("unreachable") }
        if plan.provider == "caldav" {
            guard let source = source(forCalendar: plan.calendarId, provider: "caldav"),
                  let client = caldavClient(for: source),
                  let href = plan.href.flatMap(URL.init(string:)) else { throw CalDAVError.code("unauthorized") }
            let etag = try await client.put(href, ics: body, ifMatch: plan.ifMatch)
            // The binding keeps `href::recurrenceId` for one occurrence.
            return (plan.remoteEventId ?? href.absoluteString, etag)
        }
        guard let source = source(forCalendar: plan.calendarId, provider: "google"), let email = source.accountId else {
            throw CalDAVError.code("unauthorized")
        }
        let event = try await GoogleCalendarAPI(email: email, secrets: secrets).upsert(calendarId: plan.calendarId, eventId: plan.remoteEventId, body: body)
        return (event.id, event.etag)
    }

    private func delete(_ plan: CalendarPushPlan) async throws {
        guard let remote = plan.remoteEventId else { return }
        if plan.provider == "caldav" {
            guard let source = source(forCalendar: plan.calendarId, provider: "caldav"),
                  let client = caldavClient(for: source), let href = URL(string: plan.href ?? remote) else { throw CalDAVError.code("unauthorized") }
            try await client.delete(href, ifMatch: plan.ifMatch)
            return
        }
        guard let source = source(forCalendar: plan.calendarId, provider: "google"), let email = source.accountId else {
            throw CalDAVError.code("unauthorized")
        }
        try await GoogleCalendarAPI(email: email, secrets: secrets).delete(calendarId: plan.calendarId, eventId: remote)
    }
}

extension String {
    /// The rest after `prefix`, or `nil` when it does not start with it.
    func stripping(_ prefix: String) -> String? {
        hasPrefix(prefix) ? String(dropFirst(prefix.count)) : nil
    }
}
