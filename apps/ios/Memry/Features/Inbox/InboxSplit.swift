import MemryCore
import SwiftUI

// #4349. The Inbox at regular width: the list beside the detail
// (`DESIGN.md` › Tablet › Lists and details). `InboxRouter` owns what the
// detail column shows; the list writes it through `open`, and every change to
// the list hands the selection on through `InboxDetailSelection.next`. Select
// mode turns the detail column into the bulk actions. Compact width keeps the
// phone stack in `InboxTab`.

struct InboxSplitView: View {
    let store: InboxStore
    @Binding var editMode: EditMode
    @Binding var picked: Set<String>
    @Environment(InboxRouter.self) private var router

    var body: some View {
        @Bindable var router = router
        NavigationSplitView {
            InboxScreen(store: store, editMode: $editMode, selection: $picked, split: true)
        } detail: {
            NavigationStack(path: $router.path) {
                detail
                    .navigationDestination(for: InboxRoute.self) { route in
                        switch route {
                        case let .item(id): InboxDetailView(itemId: id, store: store, inColumn: true)
                        case .inboxSettings: InboxSettingsView(store: store)
                        }
                    }
            }
        }
        .navigationSplitViewStyle(.balanced)
        .onChange(of: store.detailOrder, initial: true) { old, new in router.follow(old, new) }
        // A notification or a Share hand-off cleared the selection: the
        // first item again (D6).
        .onChange(of: router.selection == nil) { _, cleared in
            if cleared { router.follow(store.detailOrder, store.detailOrder) }
        }
    }

    @ViewBuilder private var detail: some View {
        if editMode.isEditing {
            InboxBulkDetail(store: store, picked: picked) { editMode = .inactive }
        } else if let selection = router.selection {
            InboxDetailView(itemId: selection.id, store: store, inColumn: true, marksViewed: selection.explicit)
                .id(selection.id)
        } else {
            ContentUnavailableView(InboxCopy.noSelection, systemImage: "tray", description: Text(InboxCopy.noSelectionDetail))
                .background(Tokens.Canvas.background.color)
        }
    }
}

/// Select mode's detail column: the count, and the four actions where the
/// item detail keeps its bar.
private struct InboxBulkDetail: View {
    let store: InboxStore
    let picked: Set<String>
    let finish: () -> Void
    @State private var sheets = InboxSheets()

    var body: some View {
        ContentUnavailableView {
            Label(InboxCopy.selectedCount(picked.count), systemImage: "checkmark.circle")
        } description: {
            Text(picked.isEmpty ? InboxCopy.bulkPrompt : InboxCopy.bulkHint)
        }
        .safeAreaInset(edge: .bottom) {
            InboxBulkActions(store: store, ids: Array(picked), sheets: $sheets, finish: finish)
                .padding(Tokens.Space.tight)
                .chromeGlass(in: .capsule)
                .measuredColumn(Tokens.Size.reading)
                .padding(.horizontal, InboxLayout.edge)
                .dynamicTypeSize(...InboxLayout.barTypeCap)
        }
        .background(Tokens.Canvas.background.color)
        .inboxSheets($sheets, store: store, afterExit: finish)
        .accessibilityIdentifier("inbox.bulkDetail")
    }
}

extension InboxStore {
    /// The ids of the list beside the detail column, in the order it draws
    /// them.
    var detailOrder: [String] {
        let now = clock()
        switch view {
        case .inbox: return InboxPeriod.group(visibleItems, now: now).flatMap { $0.1.map(\.id) }
        case .archived: return InboxPeriod.group(archivedByRecency, now: now, by: Self.archivedAt).flatMap { $0.1.map(\.id) }
        case .snoozed: return ((panel?.upcoming ?? []) + (panel?.past ?? [])).compactMap { $0.item?.id }
        case .insights: return []
        }
    }

    static let archivedAt: (InboxItemRecord) -> Int64 = { $0.archivedAtMs ?? $0.createdAtMs }

    /// Archived, the latest archived first.
    var archivedByRecency: [InboxItemRecord] {
        archivedItems.sorted { Self.archivedAt($0) > Self.archivedAt($1) }
    }
}
