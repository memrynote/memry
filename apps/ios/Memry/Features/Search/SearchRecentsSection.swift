import MemryCore
import SwiftUI

enum SearchRecentsCopy {
    static let header = "Recent"
    static let clear = "Clear"
    static let clearLabel = "Clear recent searches"
}

/// The empty search sheet's "Recent" section. A row reopens its item through
/// the route a hit takes: a note on Notes, a task in Tasks, a journal day in
/// Journal (through `openJournalDay`, which the sheet sets to close first).
struct SearchRecentsSection: View {
    let model: SearchRecentsViewModel
    let openNote: (String) -> Void
    let openTask: (String) -> Void

    @Environment(\.openJournalDay) private var openJournalDay

    var body: some View {
        if !model.items.isEmpty {
            Section {
                ForEach(model.items, id: \.result.id) { recent in
                    Button { open(recent) } label: {
                        SearchRecentLabel(recent: recent)
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("search.recent.\(recent.result.kind)")
                }
            } header: {
                HStack {
                    Text(SearchRecentsCopy.header)
                        .accessibilityAddTraits(.isHeader)
                    Spacer()
                    Button(SearchRecentsCopy.clear) { Task { await model.clear() } }
                        .accessibilityLabel(SearchRecentsCopy.clearLabel)
                        .accessibilityIdentifier("search.recent.clear")
                }
            }
        }
    }

    private func open(_ recent: SearchRecent) {
        let hit = recent.result
        Task { await model.record(hit, query: recent.query) }
        switch hit.kind {
        case "task":
            openTask(hit.id)
        case "journal":
            if let date = hit.journalDate.flatMap(JournalLink.date(fromWikiTarget:)) {
                openJournalDay?(date)
            }
        default:
            openNote(hit.id)
        }
    }
}

/// The item's name, then the query that found it.
private struct SearchRecentLabel: View {
    let recent: SearchRecent

    private var title: String {
        let hit = recent.result
        if let date = hit.journalDate, !date.isEmpty { return date }
        if hit.title.isEmpty { return hit.kind == "task" ? TasksCopy.untitledTask : "Untitled note" }
        return hit.title
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.tight) {
            Text(title)
                .font(Tokens.Typography.body.font)
                .foregroundStyle(Tokens.Text.primary.color)
            Text(recent.query)
                .font(Tokens.Typography.caption.font)
                .foregroundStyle(Tokens.Text.secondary.color)
        }
        .frame(maxWidth: .infinity, minHeight: Tokens.Size.minimumHitArea, alignment: .leading)
        .contentShape(.rect)
        .accessibilityElement(children: .combine)
    }
}
