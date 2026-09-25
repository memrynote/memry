import MemryCore
import SwiftUI

// IB01 / IB21. The Inbox view's list: the title header, a failure row, the
// Today / Yesterday / Older groups, or Inbox Zero when nothing waits.

struct InboxListBody<Header: View>: View {
    let store: InboxStore
    @Binding var selection: Set<String>
    @Binding var titleCollapsed: Bool
    let selecting: Bool
    let open: (InboxItemRecord) -> Void
    @ViewBuilder let header: () -> Header

    var body: some View {
        let now = store.clock()
        let groups = InboxPeriod.group(store.visibleItems, now: now)
        List {
            Group {
                header()
                    .listRowSeparator(.hidden)
                    .listRowInsets(EdgeInsets(
                        top: Tokens.Space.tight, leading: InboxLayout.edge,
                        bottom: Tokens.Space.medium, trailing: InboxLayout.edge
                    ))
                if let failure = store.failure {
                    InboxFailureRow(failure: failure, retry: { Task { await store.load() } }) { store.clearFailure() }
                        .listRowSeparator(.hidden)
                }
                if !store.hasLoaded {
                    ProgressView(InboxCopy.loading)
                        .frame(maxWidth: .infinity)
                        .listRowSeparator(.hidden)
                } else if groups.isEmpty {
                    if store.typeFilter.isEmpty {
                        InboxZeroView(stats: store.stats)
                            .listRowSeparator(.hidden)
                    } else {
                        InboxFilteredEmpty { store.typeFilter = [] }
                            .listRowSeparator(.hidden)
                    }
                }
                ForEach(groups, id: \.0) { period, rows in
                    InboxGroupHeader(period: period, count: rows.count)
                        .listRowSeparator(.hidden)
                        .listRowInsets(EdgeInsets(
                            top: period == groups.first?.0 ? Tokens.Space.small + 2 : Tokens.Space.section - 2,
                            leading: InboxLayout.edge, bottom: Tokens.Space.tight, trailing: InboxLayout.edge
                        ))
                    ForEach(rows, id: \.id) { item in
                        InboxRow(
                            item: item, store: store, now: now,
                            selecting: selecting, selected: selection.contains(item.id)
                        )
                        .onTapGesture { tap(item) }
                        .inboxRowActions(item, store: store, enabled: !selecting)
                        .listRowInsets(EdgeInsets(top: 0, leading: InboxLayout.edge, bottom: 0, trailing: InboxLayout.edge))
                        .alignmentGuide(.listRowSeparatorLeading) { _ in InboxLayout.separatorLeading }
                    }
                }
            }
            .listRowBackground(Tokens.Canvas.background.color)
        }
        .listStyle(.plain)
        .environment(\.defaultMinListRowHeight, Tokens.Size.minimumHitArea)
        .scrollContentBackground(.hidden)
        .background(Tokens.Canvas.background.color)
        .refreshable { await store.sync() }
        .onScrollGeometryChange(for: Bool.self) { geometry in
            geometry.contentOffset.y + geometry.contentInsets.top > Tokens.Size.minimumHitArea
        } action: { _, collapsed in
            titleCollapsed = collapsed
        }
        .accessibilityIdentifier("inbox.list")
    }

    private func tap(_ item: InboxItemRecord) {
        if selecting {
            if selection.contains(item.id) { selection.remove(item.id) } else { selection.insert(item.id) }
        } else {
            open(item)
        }
    }
}

/// Paper 01's geometry, mapped to tokens (§6 IB032).
enum InboxLayout {
    /// The 20pt screen edge: `Space.inset + Space.tight`.
    static let edge = Tokens.Space.inset + Tokens.Space.tight
    /// The hairline starts under the title, past the 24pt glyph lane and 12pt gap.
    static let separatorLeading = Tokens.Space.section + Tokens.Space.medium
}

/// A load or write failure, with Retry when repeating can help.
struct InboxFailureRow: View {
    let failure: UserFacingError
    let retry: () -> Void
    let dismiss: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.small) {
            ErrorNotice(error: failure, code: nil)
            HStack {
                if failure.recourse == .retry {
                    Button(InboxCopy.tryAgain, action: retry)
                        .accessibilityIdentifier("inbox.retry")
                }
                Spacer()
                Button(InboxCopy.close, systemImage: "xmark", action: dismiss)
                    .labelStyle(.iconOnly)
            }
        }
    }
}

/// The filtered list is empty: say so and offer the way back.
struct InboxFilteredEmpty: View {
    let clear: () -> Void

    var body: some View {
        ContentUnavailableView {
            Label(InboxCopy.noMatches, systemImage: "line.3.horizontal.decrease")
        } actions: {
            Button(InboxCopy.clearFilter, action: clear)
        }
    }
}
