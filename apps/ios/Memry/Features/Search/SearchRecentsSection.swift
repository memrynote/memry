import MemryCore
import SwiftUI

enum SearchRecentsCopy {
    static let header = "Recent"
    static let clear = "Clear"
    static let clearLabel = "Clear recent searches"
}

/// The empty search sheet's "Recent" section. A row reopens its item through
/// the route a hit takes (`GlobalSearchRoutes.reopen`).
struct SearchRecentsSection: View {
    let model: SearchRecentsViewModel
    let open: (SearchRecent) -> Void

    var body: some View {
        if !model.items.isEmpty {
            Section {
                ForEach(model.items, id: \.result.id) { recent in
                    Button { open(recent) } label: {
                        SearchRecentLabel(recent: recent)
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("search.recent.\(recent.result.kind)")
                    .searchRow(SearchRowKey.of(recent.result))
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
}

/// The item's name as its hit row says it, then the query that found it.
struct SearchRecentLabel: View {
    let recent: SearchRecent

    var title: String { SearchRowText(hit: recent.result).title }

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
