import MemryCore
import SwiftUI

// IB01. The Inbox tab's root screen (D1, Paper 01): the large title with
// the views menu, the subtitle, one glass capsule (filter, more), the list
// grouped by day, the floating "+" with the undo toast beside it. The title
// menu switches to Snoozed & reminders, Archived and Insights in place.

/// The Inbox tab: at compact width the list at the root, detail and settings
/// pushed on it; at regular width the list beside the detail (#4349).
struct InboxTab: View {
    let store: InboxStore?
    @Environment(InboxRouter.self) private var router
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    /// Select mode, here so the detail column can show the bulk actions.
    @State private var editMode: EditMode = .inactive
    @State private var selection: Set<String> = []

    var body: some View {
        let width = LayoutWidth(horizontal: horizontalSizeClass, vertical: verticalSizeClass)
        Group {
            if width == .regular, let store {
                InboxSplitView(store: store, editMode: $editMode, picked: $selection)
            } else {
                stack
            }
        }
        .onChange(of: width, initial: true) { router.adapt(to: width) }
    }

    private var stack: some View {
        @Bindable var router = router
        return NavigationStack(path: $router.path) {
            Group {
                if let store {
                    InboxScreen(store: store, editMode: $editMode, selection: $selection)
                } else {
                    ProgressView(InboxCopy.loading)
                }
            }
            .navigationDestination(for: InboxRoute.self) { route in
                if let store {
                    switch route {
                    case let .item(id): InboxDetailView(itemId: id, store: store)
                    case .inboxSettings: InboxSettingsView(store: store)
                    }
                }
            }
        }
    }
}

struct InboxScreen: View {
    let store: InboxStore
    @Binding var editMode: EditMode
    @Binding var selection: Set<String>
    /// The list column beside the detail: the detail column holds the bulk
    /// actions and shows the selected item.
    var split = false

    @Environment(InboxRouter.self) private var router
    @State private var titleCollapsed = false
    @State private var sheets = InboxSheets()
    @State private var composing = false
    @State private var recording = false
    /// The composer's typed text, kept when a tap outside closes it.
    @State private var composerText = ""

    private var selecting: Bool { editMode.isEditing }

    var body: some View {
        content
            .overlay {
                // A tap outside the composer closes it (the draft stays), as
                // on Tasks.
                if recording {
                    // Paper 06's scrim. A stray tap must not end a recording,
                    // so it takes the tap and does nothing with it.
                    Tokens.Canvas.surfaceActive.color.opacity(0.7)
                        .ignoresSafeArea()
                        .contentShape(.rect)
                        .onTapGesture {}
                        .accessibilityHidden(true)
                } else if composing {
                    Color.clear
                        .contentShape(.rect)
                        .onTapGesture { composing = false }
                        .accessibilityHidden(true)
                }
            }
            .overlay(alignment: .bottom) { bottomOverlay }
            // #4355: ↑ ↓ move the detail column's item, Return opens it.
            .background {
                if split, !selecting {
                    ListKeys(ids: store.detailOrder, current: router.selection?.id, move: router.focus, open: router.open)
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if composing {
                    InboxComposer(store: store, text: $composerText, recording: $recording) { composing = false }
                }
            }
            .environment(\.editMode, $editMode)
            .environment(\.inboxRowIntents, intents)
            .navigationTitle(titleCollapsed ? store.viewTitle : "")
            .navigationSubtitle(titleCollapsed ? store.viewSubtitle : "")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarTitleMenu { if !selecting { InboxTitleMenu(store: store) } }
            .toolbar { toolbar }
            .toolbar(!split && (selecting || recording) ? .hidden : .automatic, for: .tabBar)
            .navigationBarBackButtonHidden(selecting)
            .inboxSheets($sheets, store: store) { editMode = .inactive }
            .task { await store.load() }
            .onChange(of: selecting) { _, now in if !now { selection = [] } }
            .background(Tokens.Canvas.background.color)
    }

    @ViewBuilder private var content: some View {
        switch store.view {
        case .inbox:
            InboxListBody(
                store: store, selection: $selection, titleCollapsed: $titleCollapsed,
                selecting: selecting, current: split ? router.selection?.id : nil, open: { router.open($0.id) }
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
            convert: { sheets.convert = InboxConvertRequest(item: $0, target: $1) },
            pickSnooze: { sheets.snooze = InboxIdList(ids: $0) },
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
            if !split {
                InboxSelectionToolbar(store: store, selection: $selection, sheets: $sheets) { editMode = .inactive }
            }
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
            GlobalSearchToolbarItem()
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
