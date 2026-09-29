import MemryCore
import SwiftUI

// The vault-wide search behind the magnifier every root screen carries in
// the same top trailing slot. One sheet over the whole shell, so a query
// reads the same whichever page it started on.
//
// **Where a hit opens.** A note opens on the Notes page, a task in Tasks and a
// journal hit on its day in Journal, each closing the sheet first, wherever
// those pages sit in the bar.

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
    static let prompt = "Search notes, journal and tasks"
    static let unavailable = "Search is not available"
    static let unavailableDetail = "This vault's search index could not be opened on this iPhone."
}

struct GlobalSearchSheet: View {
    let browse: VaultBrowseViewModel?
    let openNote: (String) -> Void
    let openTask: (String) -> Void
    let openJournalDay: (String) -> Void

    @State private var model: VaultSearchViewModel?
    @State private var query = ""
    @FocusState private var isFocused: Bool
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            results
                .navigationTitle(GlobalSearchCopy.open)
                .navigationBarTitleDisplayMode(.inline)
                .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: GlobalSearchCopy.prompt)
                .searchFocused($isFocused)
                .onChange(of: query) { _, query in model?.run(query) }
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button(role: .close) { dismiss() }
                            .accessibilityIdentifier("search.close")
                    }
                }
        }
        // A journal hit (`SearchHitRow`) opens its day through this.
        .environment(\.openJournalDay) { date in
            dismiss()
            openJournalDay(date)
        }
        .task {
            if model == nil, let searcher = browse?.searcher {
                model = VaultSearchViewModel(search: searcher)
            }
            isFocused = true
            await model?.prepare()
        }
    }

    @ViewBuilder private var results: some View {
        if browse != nil, model == nil, browse?.searcher == nil {
            ContentUnavailableView(GlobalSearchCopy.unavailable, systemImage: "magnifyingglass", description: Text(GlobalSearchCopy.unavailableDetail))
        } else {
            List {
                switch model?.phase {
                case let .results(hits) where !hits.isEmpty || !(model?.taskHits.isEmpty ?? true):
                    ForEach(hits, id: \.id) { hit in
                        if hit.kind == "journal" {
                            SearchHitRow(hit: hit)
                        } else {
                            Button {
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
                    EmptyView()
                }
            }
            .listStyle(.plain)
            .accessibilityIdentifier("search.results")
        }
    }
}
