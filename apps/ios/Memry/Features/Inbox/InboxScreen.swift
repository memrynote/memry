import MemryCore
import SwiftUI

// IB01. The Inbox screen pushed from More (D1, Paper 01): the large title with
// the views menu, the subtitle, one glass capsule (filter, more), the list
// grouped by day, the floating "+" with the undo toast beside it. The title
// menu switches to Snoozed & reminders, Archived and Insights in place.

struct InboxDestination: View {
    let route: MoreRoute
    let store: InboxStore?

    var body: some View {
        if let store {
            switch route {
            case .inbox: InboxScreen(store: store)
            case let .item(id): InboxDetailView(itemId: id, store: store)
            case .inboxSettings: InboxSettingsView(store: store)
            }
        } else {
            ProgressView(InboxCopy.loading)
        }
    }
}

struct InboxScreen: View {
    let store: InboxStore

    @Environment(InboxRouter.self) private var router
    @State private var editMode: EditMode = .inactive
    @State private var selection: Set<String> = []
    @State private var titleCollapsed = false
    @State private var sheets = InboxSheets()
    @State private var composing = false

    private var selecting: Bool { editMode.isEditing }

    var body: some View {
        content
            .overlay(alignment: .bottom) { bottomOverlay }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if composing {
                    InboxComposer(store: store) { composing = false }
                }
            }
            .environment(\.editMode, $editMode)
            .environment(\.inboxRowIntents, intents)
            .navigationTitle(titleCollapsed ? store.viewTitle : "")
            .navigationSubtitle(titleCollapsed ? store.viewSubtitle : "")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarTitleMenu { if !selecting { InboxTitleMenu(store: store) } }
            .toolbar { toolbar }
            .toolbar(selecting ? .hidden : .automatic, for: .tabBar)
            .inboxSheets($sheets, store: store)
            .task { await store.load() }
            .onChange(of: selecting) { _, now in if !now { selection = [] } }
            .background(Tokens.Canvas.background.color)
    }

    @ViewBuilder private var content: some View {
        switch store.view {
        case .inbox:
            InboxListBody(
                store: store, selection: $selection, titleCollapsed: $titleCollapsed,
                selecting: selecting, open: { router.path.append(.item($0.id)) }
            ) {
                InboxTitleHeader(store: store, selectedCount: selecting ? selection.count : nil)
            }
        case .snoozed:
            InboxSnoozedView(store: store, titleCollapsed: $titleCollapsed) { InboxTitleHeader(store: store) }
        case .archived:
            InboxArchivedView(store: store, titleCollapsed: $titleCollapsed) { InboxTitleHeader(store: store) }
        case .insights:
            InboxInsightsView(store: store, titleCollapsed: $titleCollapsed) { InboxTitleHeader(store: store) }
        }
    }

    private var intents: InboxRowIntents {
        InboxRowIntents(
            file: { sheets.file = InboxFileRequest(ids: [$0.id]) },
            quickFile: { item, folder in Task { await store.file(item, to: folder, tags: []) } },
            convert: { sheets.convert = $0 },
            pickSnooze: { sheets.snoozeIds = $0 },
            rename: { sheets.rename = $0 },
            select: { item in
                editMode = .active
                selection = [item.id]
            }
        )
    }

    private var bottomOverlay: some View {
        HStack(alignment: .center, spacing: Tokens.Space.medium) {
            InboxToastView(store: store)
            if !composing, !selecting, store.view == .inbox {
                FloatingAddButton(
                    label: InboxCopy.capture,
                    hint: InboxCopy.captureHint,
                    identifier: "inbox.addButton"
                ) { composing = true }
            }
        }
        .padding(.horizontal, Tokens.Space.inset)
        .padding(.bottom, Tokens.Space.medium)
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        if selecting {
            ToolbarItem(placement: .topBarLeading) {
                Button(selection.count == store.visibleItems.count ? InboxCopy.deselectAll : InboxCopy.selectAll) {
                    if selection.count == store.visibleItems.count {
                        selection = []
                    } else {
                        selection = Set(store.visibleItems.map(\.id))
                    }
                }
                .accessibilityIdentifier("inbox.selectAll")
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    editMode = .inactive
                } label: {
                    Image(systemName: "checkmark").foregroundStyle(Tokens.Tint.foreground.color)
                }
                .buttonStyle(.glassProminent)
                .tint(Tokens.Tint.base.color)
                .accessibilityLabel(InboxCopy.done)
                .accessibilityIdentifier("inbox.selectDone")
            }
            InboxSelectionToolbar(store: store, selection: $selection, sheets: $sheets) { editMode = .inactive }
        } else if store.view == .inbox {
            ToolbarItemGroup(placement: .topBarTrailing) {
                InboxFilterMenu(store: store)
                Menu {
                    Button(InboxCopy.select, systemImage: "checkmark.circle") { editMode = .active }
                        .accessibilityIdentifier("inbox.more.select")
                    Button(InboxCopy.inboxSettings, systemImage: "gearshape") { router.path.append(.inboxSettings) }
                        .accessibilityIdentifier("inbox.more.settings")
                } label: {
                    Image(systemName: "ellipsis").accessibilityLabel(InboxCopy.more)
                }
                .accessibilityIdentifier("inbox.moreButton")
            }
        }
    }
}

/// The undo toast beside the "+" (Paper 17), shared card from `Design/`.
struct InboxToastView: View {
    let store: InboxStore
    @Environment(\.accessibilityVoiceOverEnabled) private var voiceOver

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            if let toast = store.toast {
                UndoToastCard(
                    message: toast.message,
                    undoTitle: InboxCopy.undo,
                    undoHint: InboxCopy.undoHint,
                    identifier: "inbox.toast",
                    undo: toast.undo.map { undo in { Task { await undo() } } }
                )
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .calmAnimation(.normal, value: store.toast)
        .task(id: store.toast) {
            guard let toast = store.toast else { return }
            AccessibilityNotification.Announcement(toast.message).post()
            try? await Task.sleep(for: .seconds(voiceOver ? 10 : 4))
            if store.toast == toast { store.toast = nil }
        }
    }
}
