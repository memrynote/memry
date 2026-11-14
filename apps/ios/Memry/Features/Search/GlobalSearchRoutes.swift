import MemryCore

/// Where the search sheet sends an opened hit or recent, in one place so every
/// way of activating a row (a tap, VoiceOver, Switch Control, the keyboard)
/// takes the same path: the open is recorded as a recent, the sheet closes,
/// and the item's page opens.
///
/// A note or journal hit hands its page the query (`SearchFindRequests`),
/// which opens find on the first matching block. A recent carries no query:
/// it clears any query still waiting, so a page never opens find on the word
/// of an earlier search.
@MainActor
struct GlobalSearchRoutes {
    let record: (SearchResult, String) -> Void
    let finds: SearchFindRequests
    let dismiss: () -> Void
    let openNote: (String) -> Void
    let openTask: (String) -> Void
    let openInboxItem: (String) -> Void
    let openJournalDay: (String) -> Void

    /// A hit of the search for `query`.
    func open(_ hit: SearchResult, query: String) {
        record(hit, query)
        Telemetry.shared.track(.searchResultOpened, surface: .search, action: "opened", objectType: Self.objectType(hit.kind))
        route(hit, find: query)
    }

    /// A row of the empty sheet's recents.
    func reopen(_ recent: SearchRecent) {
        record(recent.result, recent.query)
        route(recent.result, find: nil)
    }

    private func route(_ hit: SearchResult, find query: String?) {
        switch hit.kind {
        case "task":
            hand(nil, query: nil)
            openTask(hit.id)
        case "inbox":
            hand(nil, query: nil)
            openInboxItem(hit.id)
        case "journal" where Self.journalDate(hit) != nil:
            let date = Self.journalDate(hit) ?? ""
            hand(.journalDay(date), query: query)
            openJournalDay(date)
        default:
            hand(.note(hit.id), query: query)
            openNote(hit.id)
        }
    }

    /// Leaves `query` waiting for `target`'s page, or no query at all, then
    /// closes the sheet.
    private func hand(_ target: FindTarget?, query: String?) {
        if let target, let query {
            finds.open(target, query: query)
        } else {
            finds.clear()
        }
        dismiss()
    }

    private static func objectType(_ kind: String) -> StaticString {
        switch kind {
        case "task": "task"
        case "inbox": "inbox"
        case "journal": "journal"
        default: "note"
        }
    }

    private static func journalDate(_ hit: SearchResult) -> String? {
        hit.journalDate.flatMap(JournalLink.date(fromWikiTarget:))
    }
}
