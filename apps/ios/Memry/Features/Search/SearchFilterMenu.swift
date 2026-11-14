import MemryCore
import SwiftUI

// The search sheet's filter menu (#4321): one date preset at a time, any
// number of tags, and a way to clear both. The icon fills while either is
// on. Tags come from the core's tag list, the one the Tags screen shows.

enum SearchFilterCopy {
    static let title = "Filters"
    static let tags = "Tags"
    static let noTags = "No tags yet"
    static let clear = "Clear filters"
    static let on = "On"
    static let off = "Off"
}

struct SearchFilterMenu: View {
    let filters: SearchFilters
    let apply: (SearchFilters) -> Void

    @State private var tags: [String] = []
    @Environment(\.settingsContext) private var settingsContext

    var body: some View {
        Menu {
            Section {
                ForEach(SearchDatePreset.allCases, id: \.self) { preset in
                    Toggle(preset.title, isOn: picked(filters.date == preset) { $0.toggle(preset) })
                }
            }
            Menu(SearchFilterCopy.tags) {
                if tags.isEmpty {
                    Text(SearchFilterCopy.noTags)
                }
                ForEach(tags, id: \.self) { tag in
                    Toggle(tag, isOn: picked(filters.tags.contains(tag)) { $0.toggle(tag: tag) })
                        .menuActionDismissBehavior(.disabled)
                }
            }
            Button(SearchFilterCopy.clear, systemImage: "xmark.circle") {
                var cleared = filters
                cleared.clear()
                apply(cleared)
            }
            .disabled(!filters.isNarrowed)
        } label: {
            Label(
                SearchFilterCopy.title,
                systemImage: filters.isNarrowed
                    ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease.circle"
            )
        }
        .accessibilityValue(filters.isNarrowed ? SearchFilterCopy.on : SearchFilterCopy.off)
        .accessibilityIdentifier("search.filter")
        .task { await loadTags() }
    }

    /// A checkmark item bound to one choice, written back through ``apply``.
    private func picked(_ isOn: Bool, _ change: @escaping (inout SearchFilters) -> Void) -> Binding<Bool> {
        Binding(
            get: { isOn },
            set: { _ in
                var next = filters
                change(&next)
                apply(next)
            }
        )
    }

    /// A failed read leaves the tag submenu empty: the other filters and the
    /// search itself still work.
    private func loadTags() async {
        guard let settingsContext else { return }
        switch await settingsContext.read({ try $0.tagList() }) {
        case let .success(list): tags = list.map(\.name)
        case let .failure(error): Log.storage.error("search tags could not be read", .code(error.code))
        }
    }
}
