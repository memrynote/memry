import MemryCore
import Testing

@testable import Memry

// Where the search sheet sends an opened row (REVIEW-4419 #2, #5). Every way
// of activating a row runs the same action, so these drive that action.

@MainActor
@Suite("Search sheet routes")
struct GlobalSearchRoutesTests {
    final class Trail {
        var steps: [String] = []
    }

    private func routes(_ trail: Trail, finds: SearchFindRequests) -> GlobalSearchRoutes {
        GlobalSearchRoutes(
            record: { hit, query in trail.steps.append("record \(hit.id) \(query)") },
            finds: finds,
            dismiss: { trail.steps.append("dismiss") },
            openNote: { trail.steps.append("note \($0)") },
            openTask: { trail.steps.append("task \($0)") },
            openInboxItem: { trail.steps.append("inbox \($0)") },
            openJournalDay: { trail.steps.append("journal \($0)") }
        )
    }

    private func hit(_ id: String, kind: String, journalDate: String? = nil) -> SearchResult {
        SearchResult(id: id, title: id, kind: kind, journalDate: journalDate, emoji: nil, folderPath: nil, score: -1, snippet: [], matchKind: .body, matchedName: nil)
    }

    @Test func a_journal_hit_is_recorded_and_opens_its_day_with_find() {
        let trail = Trail()
        let finds = SearchFindRequests()

        routes(trail, finds: finds).open(hit("j1", kind: "journal", journalDate: "2026-11-10"), query: "router")

        #expect(trail.steps == ["record j1 router", "dismiss", "journal 2026-11-10"])
        #expect(finds.take(for: .journalDay("2026-11-10")) == "router")
    }

    @Test func a_recent_note_or_task_leaves_no_earlier_query_waiting() {
        for (recent, opened) in [(hit("n1", kind: "note"), "note n1"), (hit("t1", kind: "task"), "task t1")] {
            let trail = Trail()
            let finds = SearchFindRequests()
            // An earlier hit's query its page never took.
            finds.open(.note("n1"), query: "router")

            routes(trail, finds: finds).reopen(SearchRecent(result: recent, query: "rent", visitedAt: 1))

            #expect(trail.steps == ["record \(recent.id) rent", "dismiss", opened])
            #expect(finds.pending == nil, "\(recent.kind) left a query waiting")
        }
    }
}
