import MemryCore
import SwiftUI

/// The search sheet's "Inbox" section, after Tasks (#4320). A capture opens
/// in Inbox, whatever its state: filed, archived and snoozed ones match too.
struct SearchInboxSection: View {
    let hits: [SearchResult]
    let open: (SearchResult) -> Void

    var body: some View {
        if !hits.isEmpty {
            Section {
                ForEach(hits, id: \.id) { hit in
                    Button { open(hit) } label: {
                        InboxSearchHitLabel(hit: hit)
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint(SearchInboxCopy.openInInbox)
                    .accessibilityIdentifier("search.result.inbox")
                }
            } header: {
                Text(InboxCopy.title)
                    .accessibilityAddTraits(.isHeader)
            }
        }
    }
}

enum SearchInboxCopy {
    static let openInInbox = "Open in Inbox"
}

/// One capture hit: the Inbox tab's tray, the title, then the snippet.
struct InboxSearchHitLabel: View {
    let hit: SearchResult

    var body: some View {
        let text = SearchRowText(hit: hit)
        HStack(alignment: .firstTextBaseline, spacing: Tokens.Space.small) {
            Image(systemName: VaultTab.inbox.symbol)
                .font(Tokens.Typography.body.font)
                .foregroundStyle(Tokens.Text.secondary.color)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: Tokens.Space.tight) {
                Text(text.title)
                    .font(Tokens.Typography.body.font)
                    .foregroundStyle(Tokens.Text.primary.color)
                    .lineLimit(1)
                SearchSnippetText(segments: hit.snippet)
            }
            Spacer(minLength: Tokens.Space.tight)
        }
        .frame(maxWidth: .infinity, minHeight: Tokens.Size.minimumHitArea, alignment: .leading)
        .contentShape(.rect)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(text.accessibilityLabel)
    }
}
