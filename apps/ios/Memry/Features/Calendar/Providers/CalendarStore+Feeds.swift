import Foundation
import MemryCore

// Spec 007 CL073. Subscribed calendars on this iPhone: subscribe fetches and
// parses before anything is saved (a wrong link fails with its reason), and
// the runner re-reads each visible feed once its refresh time has passed.

extension CalendarStore {
    /// Subscribes to a pasted link. Returns an `IcsFeedErrorCode` on failure.
    func subscribeFeed(_ input: String, title: String?) async -> String? {
        guard let url = calendarFeedNormalizeUrl(input: input) else { return "invalid_url" }
        switch await CalendarFeedFetcher().fetch(url, etag: nil, lastModified: nil) {
        case let .failed(code):
            return code
        case .notModified:
            return "http_error"
        case let .body(feed):
            let zones = CalendarFeedFetcher.zones(for: feed.text)
            let name = title?.trimmingCharacters(in: .whitespaces)
            let result: Result<String, any Error> = await feedCall { core in
                try core.feedSubscribe(url: url, title: name?.isEmpty == false ? name : nil, feed: feed, zones: zones)
            }
            switch result {
            case .success:
                await afterFeedChange()
                return nil
            case let .failure(error):
                return Self.feedCode(error)
            }
        }
    }

    /// One pass over the feeds due now (every live one with `force`).
    /// Returns how many failed.
    @discardableResult
    func refreshFeeds(force: Bool = false) async -> Int {
        let due: Result<[CalendarFeedDue], any Error> = await feedCall { try $0.feedsDue(force: force) }
        guard case let .success(feeds) = due, !feeds.isEmpty else { return 0 }
        var failures = 0
        let fetcher = CalendarFeedFetcher()
        for feed in feeds {
            let outcome = await fetcher.fetch(feed.url, etag: feed.etag, lastModified: feed.lastModified)
            let id = feed.sourceId
            let recorded: Result<Void, any Error> = await feedCall { core in
                switch outcome {
                case let .body(body):
                    _ = try core.feedRecordFetch(sourceId: id, feed: body, zones: CalendarFeedFetcher.zones(for: body.text))
                case .notModified:
                    try core.feedRecordNotModified(sourceId: id)
                case let .failed(code):
                    try core.feedRecordError(sourceId: id, code: code)
                }
            }
            if case .failed = outcome { failures += 1 }
            if case .failure = recorded { failures += 1 }
        }
        await afterFeedChange()
        return failures
    }

    func feedStates() async -> [CalendarFeedState] {
        (try? await feedCall { try $0.feedStates() }.get()) ?? []
    }

    func renameFeed(_ sourceId: String, title: String?, color: String?) async {
        _ = await write { try $0.feedUpdate(sourceId: sourceId, title: title, color: color) }
    }

    func unsubscribeFeed(_ sourceId: String) async {
        _ = await write { try $0.feedUnsubscribe(sourceId: sourceId) }
    }

    private func afterFeedChange() async {
        await refreshSources()
        await refreshAllWindows()
        scheduleSync()
    }

    /// A core call whose error the caller turns into a feed code.
    private func feedCall<T: Sendable>(_ work: @escaping @Sendable (any VaultCalendarProtocol) throws -> T) async -> Result<T, any Error> {
        let core = core
        do {
            return try .success(await CoreExecutor.shared.run { try work(core) })
        } catch {
            return .failure(error)
        }
    }

    /// `StorageError.Invalid(what: "not_a_calendar")` → the code.
    static func feedCode(_ error: any Error) -> String {
        if case let StorageError.Invalid(what) = error, !what.contains(" ") { return what }
        return "not_a_calendar"
    }
}
