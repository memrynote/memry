import MemryCore
import SwiftUI

// The vault-wide search behind the magnifier every root screen carries in
// the same top trailing slot. One sheet over the whole shell, so a query
// reads the same whichever page it started on.
//
// **Where a hit opens.** A note opens on the Notes page, a task in Tasks, an
// inbox capture in Inbox and a journal hit on its day in Journal, each closing the sheet first, wherever
// those pages sit in the bar. A note or journal hit hands its page the query
// (`SearchFindRequests`), which opens find on the first matching block.

extension EnvironmentValues {
    /// Opens the vault-wide search sheet. `nil` outside the vault shell.
    @Entry var openGlobalSearch: (@MainActor () -> Void)?
    /// The opened vault's browse surface (reader, writers, search), set by
    /// the settings scope that builds it.
    @Entry var vaultBrowse: VaultBrowseViewModel?
}

/// The magnifier a root screen puts in its top trailing slot.
struct GlobalSearchToolbarItem: ToolbarContent {
    @Environment(\.openGlobalSearch) private var openGlobalSearch

    var body: some ToolbarContent {
        if let openGlobalSearch {
            ToolbarItem(placement: .topBarTrailing) {
                Button(GlobalSearchCopy.open, systemImage: "magnifyingglass") { openGlobalSearch() }
                    .accessibilityIdentifier("search.open")
            }
        }
    }
}

enum GlobalSearchCopy {
    static let open = "Search"
    static let prompt = "Search notes, tasks, journal, inbox"
    static let unavailable = "Search is not available"
    static let unavailableDetail = "This vault's search index could not be opened on this iPhone."
    static let stale = "Search may be out of date"
    static let retry = "Retry"
}

struct GlobalSearchSheet: View {
    let browse: VaultBrowseViewModel?
    let openNote: (String) -> Void
    let openTask: (String) -> Void
    let openInboxItem: (String) -> Void
    let openJournalDay: (String) -> Void

    @State private var model: VaultSearchViewModel?
    @State private var recents: SearchRecentsViewModel?
    @State private var query = ""
    @FocusState private var isFocused: Bool
    @Environment(\.dismiss) private var dismiss
    @Environment(\.vaultSearchIndex) private var searchIndex

    var body: some View {
        NavigationStack {
            results
                .navigationTitle(GlobalSearchCopy.open)
                .navigationBarTitleDisplayMode(.inline)
                .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: GlobalSearchCopy.prompt)
                .searchScopes(scope) {
                    ForEach(SearchScope.allCases, id: \.self) { Text($0.title).tag($0) }
                }
                .searchFocused($isFocused)
                .onChange(of: query) { _, query in model?.run(query) }
                .onChange(of: searchIndex?.completed) { model?.rerun() }
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button(role: .close) { dismiss() }
                            .accessibilityIdentifier("search.close")
                    }
                    // The bottom bar stays while the search is active; the top
                    // bar's trailing items do not.
                    if let model {
                        ToolbarItem(placement: .bottomBar) {
                            SearchFilterMenu(filters: model.filters, apply: model.apply)
                        }
                    }
                }
        }
        // A journal hit (`SearchHitRow`) opens its day through this.
        .environment(\.openJournalDay) { date in
            SearchFindRequests.shared.open(.journalDay(date), query: query)
            dismiss()
            openJournalDay(date)
        }
        .task {
            if model == nil, let searcher = browse?.searcher {
                model = VaultSearchViewModel(search: searcher, index: searchIndex)
            }
            if recents == nil, let store = browse?.recents {
                recents = SearchRecentsViewModel(store: store)
            }
            isFocused = true
            await recents?.load()
        }
    }

    @ViewBuilder private var results: some View {
        if browse != nil, model == nil, browse?.searcher == nil {
            ContentUnavailableView(GlobalSearchCopy.unavailable, systemImage: "magnifyingglass", description: Text(GlobalSearchCopy.unavailableDetail))
        } else {
            List {
                if let model, model.isIndexStale {
                    Section {
                        HStack {
                            Text(GlobalSearchCopy.stale)
                                .foregroundStyle(Tokens.Text.secondary.color)
                            Spacer()
                            Button(GlobalSearchCopy.retry) { Task { await model.retryIndex() } }
                                .accessibilityIdentifier("search.stale.retry")
                        }
                    }
                }
                switch model?.phase {
                case let .results(hits) where !hits.isEmpty || !(model?.taskHits.isEmpty ?? true)
                    || !(model?.inboxHits.isEmpty ?? true):
                    ForEach(hits, id: \.id) { hit in
                        if hit.kind == "journal" {
                            SearchHitRow(hit: hit)
                                .simultaneousGesture(TapGesture().onEnded { record(hit) })
                        } else {
                            Button {
                                record(hit)
                                Telemetry.shared.track(.searchResultOpened, surface: .search, action: "opened", objectType: "note")
                                SearchFindRequests.shared.open(.note(hit.id), query: query)
                                dismiss()
                                openNote(hit.id)
                            } label: {
                                SearchHitLabel(hit: hit)
                                    .frame(minHeight: Tokens.Size.minimumHitArea)
                                    .contentShape(.rect)
                            }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("search.result.note")
                        }
                    }
                    if let tasks = model?.taskHits, !tasks.isEmpty {
                        Section {
                            ForEach(tasks, id: \.id) { hit in
                                Button {
                                    record(hit)
                                    Telemetry.shared.track(.searchResultOpened, surface: .search, action: "opened", objectType: "task")
                                    dismiss()
                                    openTask(hit.id)
                                } label: {
                                    TaskSearchHitLabel(hit: hit)
                                }
                                .buttonStyle(.plain)
                                .accessibilityHint(TasksCopy.openInTasks)
                                .accessibilityIdentifier("search.result.task")
                            }
                        } header: {
                            Text(TasksCopy.searchTasksSection)
                                .accessibilityAddTraits(.isHeader)
                        }
                    }
                    SearchInboxSection(hits: model?.inboxHits ?? []) { hit in
                        record(hit)
                        dismiss()
                        openInboxItem(hit.id)
                    }
                case .results:
                    ContentUnavailableView.search(text: query)
                        .listRowSeparator(.hidden)
                case let .failed(error):
                    ErrorNotice(error: error, code: nil)
                        .listRowSeparator(.hidden)
                case .searching:
                    ProgressView()
                        .frame(maxWidth: .infinity)
                        .listRowSeparator(.hidden)
                case .idle, .none:
                    if let recents {
                        SearchRecentsSection(
                            model: recents,
                            openNote: { dismiss(); openNote($0) },
                            openTask: { dismiss(); openTask($0) },
                            openInboxItem: { dismiss(); openInboxItem($0) }
                        )
                    }
                }
            }
            .listStyle(.plain)
            .accessibilityIdentifier("search.results")
        }
    }

    /// The scope picker's selection, held by the model with the menu's
    /// filters.
    private var scope: Binding<SearchScope> {
        Binding(
            get: { model?.filters.scope ?? .all },
            set: { scope in
                guard var filters = model?.filters else { return }
                filters.scope = scope
                model?.apply(filters)
            }
        )
    }

    private func record(_ hit: SearchResult) {
        guard let recents else { return }
        Task { await recents.record(hit, query: query) }
    }
}
