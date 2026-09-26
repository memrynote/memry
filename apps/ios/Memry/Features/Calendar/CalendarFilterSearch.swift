import MemryCore
import SwiftUI

// Spec 007 CL036/CL037 (artboards 10, 11). The filter sheet (sources
// switches, the seven type chips, one calendar list per provider where a
// "Not syncing" calendar subscribes when ticked, refresh, Manage accounts) and
// search (grouped results; a tap jumps to Day and opens the item).

struct CalendarFilterSheet: View {
    @Bindable var store: CalendarStore
    let manageAccounts: () -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section(CalendarCopy.sources) {
                    Toggle(CalendarCopy.memryItems, isOn: $store.state.showMemryItems)
                        .accessibilityIdentifier("calendar.filter.memry")
                    Toggle(CalendarCopy.importedCalendars, isOn: $store.state.showImportedCalendars)
                        .accessibilityIdentifier("calendar.filter.imported")
                }
                .tint(Tokens.Tint.base.color)
                Section(CalendarCopy.eventTypes) {
                    typeChips
                        .listRowBackground(Color.clear)
                        .listRowInsets(EdgeInsets())
                }
                if store.importedSources.isEmpty {
                    Section { Text(CalendarCopy.noImportedCalendars).foregroundStyle(Tokens.Text.tertiary.color) }
                }
                ForEach(providers, id: \.self) { provider in
                    Section(CalendarCopy.providerCalendars(provider)) {
                        ForEach(store.importedSources.filter { $0.provider == provider }, id: \.id) { source in
                            sourceRow(source)
                        }
                    }
                }
                Section {
                } footer: {
                    // Paper 10: the scope note and the way to the accounts.
                    HStack {
                        Text(CalendarCopy.filterScope)
                        Spacer()
                        Button(CalendarCopy.manageAccounts, action: manageAccounts)
                            .font(Tokens.Typography.caption.font.weight(.semibold))
                            .foregroundStyle(Tokens.Text.tint.color)
                            .frame(minHeight: Tokens.Size.minimumHitArea)
                            .accessibilityIdentifier("calendar.filter.manage")
                    }
                }
            }
            .listSectionSpacing(Tokens.Space.medium)
            .navigationTitle(CalendarCopy.filterCalendars)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                // Paper 10: refresh on the left in ink, the filled check closes.
                ToolbarItem(placement: .topBarLeading) {
                    Button { Task { await store.sync() } } label: {
                        if store.isSyncing {
                            ProgressView()
                        } else {
                            Image(systemName: "arrow.clockwise").foregroundStyle(Tokens.Text.primary.color)
                        }
                    }
                    .accessibilityLabel(CalendarCopy.refreshCalendars)
                    .accessibilityIdentifier("calendar.filter.refresh")
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button { dismiss() } label: {
                        Image(systemName: "checkmark").foregroundStyle(Tokens.Tint.foreground.color)
                    }
                    .buttonStyle(.glassProminent)
                    .tint(Tokens.Tint.base.color)
                    .accessibilityLabel(CalendarCopy.done)
                    .accessibilityIdentifier("calendar.filter.done")
                }
            }
        }
        .presentationDetents([.large])
    }

    private var providers: [String] {
        let order = ["google", "caldav", "ics", "apple-eventkit"]
        return Array(Set(store.importedSources.map(\.provider))).sorted {
            (order.firstIndex(of: $0) ?? 9, $0) < (order.firstIndex(of: $1) ?? 9, $1)
        }
    }

    private var typeChips: some View {
        // Paper 10: wrapping chips, filled ink when on, quiet when off.
        return TaskFlowLayout(horizontal: Tokens.Space.small, vertical: Tokens.Space.small) {
            ForEach(CalendarVisualType.allCases) { type in
                let on = store.state.visualTypes.contains(type)
                Button {
                    if on { store.state.visualTypes.removeAll { $0 == type } } else { store.state.visualTypes.append(type) }
                } label: {
                    HStack(spacing: Tokens.Space.small) {
                        Circle().fill(Tokens.Calendar.hue(visualType: type.rawValue).rail.color).frame(width: 7, height: 7)
                        Text(CalendarCopy.visualType(type.rawValue))
                            .font(Tokens.Typography.supporting.font.weight(.medium))
                            .foregroundStyle(on ? Tokens.Canvas.background.color : Tokens.Text.secondary.color)
                    }
                    .padding(.horizontal, Tokens.Space.medium)
                    .padding(.vertical, Tokens.Space.small)
                    .background(on ? Tokens.Text.primary.color : Tokens.Canvas.surface.color, in: .capsule)
                    .frame(minHeight: Tokens.Size.minimumHitArea)
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(on ? .isSelected : [])
                .accessibilityIdentifier("calendar.filter.type.\(type.rawValue)")
            }
        }
    }

    private func sourceRow(_ source: CalendarSourceRecord) -> some View {
        let selected = store.selectedImportedSourceIds.contains(source.id)
        return Button {
            let decision = CalendarSourceSelection.toggle(
                source.id, selected: store.selectedImportedSourceIds,
                sources: store.importedSources.map { .init(id: $0.id, isSelected: $0.isSelected) }
            )
            store.state.importedSourceIds = decision.next
            if let subscribe = decision.subscribe {
                Task {
                    if await store.write({ try $0.setSourceSelected(sourceId: subscribe, selected: true) }) == nil {
                        store.showToast(CalendarCopy.enableSourceFailed)
                    }
                }
            }
        } label: {
            HStack(spacing: Tokens.Space.medium) {
                Circle()
                    .fill(source.color.flatMap { Tokens.Calendar.hue(hex: $0)?.rail.color } ?? Tokens.Text.tertiary.color)
                    .frame(width: 8, height: 8)
                VStack(alignment: .leading, spacing: 2) {
                    Text(source.title).foregroundStyle(Tokens.Text.primary.color)
                    if !source.isSelected {
                        Text(CalendarCopy.notSyncing)
                            .font(Tokens.Typography.caption.font)
                            .foregroundStyle(Tokens.Text.tertiary.color)
                    }
                }
                Spacer()
                if selected {
                    Image(systemName: "checkmark")
                        .font(Tokens.Typography.supporting.font.weight(.semibold))
                        .foregroundStyle(Tokens.Text.tint.color)
                }
            }
            .frame(minHeight: Tokens.Size.minimumHitArea)
        }
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier("calendar.filter.source.\(source.id)")
    }
}

struct CalendarSearchSheet: View {
    @Bindable var store: CalendarStore
    let jump: (CalendarItem) -> Void
    @State private var query = ""
    @State private var results: [CalendarItem] = []
    @Environment(\.dismiss) private var dismiss

    @FocusState private var focused: Bool

    /// Paper 11: a field and a close button over plain grouped rows, the
    /// keyboard up from the start.
    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: Tokens.Space.small) {
                HStack(spacing: Tokens.Space.small) {
                    Image(systemName: "magnifyingglass").foregroundStyle(Tokens.Text.secondary.color)
                    TextField(CalendarCopy.searchPlaceholder, text: $query)
                        .focused($focused)
                        .submitLabel(.search)
                        .autocorrectionDisabled()
                        .accessibilityIdentifier("calendar.search.field")
                    if !query.isEmpty {
                        Button { query = "" } label: {
                            Image(systemName: "xmark.circle.fill").foregroundStyle(Tokens.Text.tertiary.color)
                        }
                        .accessibilityLabel(CalendarCopy.clearSearch)
                    }
                }
                .padding(.horizontal, Tokens.Space.medium)
                .frame(minHeight: Tokens.Size.minimumHitArea)
                .glassEffect(.regular, in: .capsule)
                Button { dismiss() } label: {
                    Image(systemName: "xmark")
                        .foregroundStyle(Tokens.Text.primary.color)
                        .frame(width: Tokens.Size.minimumHitArea, height: Tokens.Size.minimumHitArea)
                }
                .glassEffect(.regular.interactive(), in: .circle)
                .accessibilityLabel(CalendarCopy.close)
                .accessibilityIdentifier("calendar.search.close")
            }
            .padding(.horizontal, Tokens.Space.inset)
            .padding(.vertical, Tokens.Space.small)
            List {
                if !query.trimmingCharacters(in: .whitespaces).isEmpty, results.isEmpty {
                    Text(CalendarCopy.noResults).foregroundStyle(Tokens.Text.tertiary.color)
                }
                ForEach(groups, id: \.title) { group in
                    Section {
                        ForEach(group.items, id: \.projectionId) { item in
                            Button { jump(item) } label: { row(item) }
                                .accessibilityIdentifier("calendar.search.result.\(item.projectionId)")
                        }
                    } header: {
                        Text(group.title)
                            .font(Tokens.Typography.caption.font.weight(.semibold))
                            .foregroundStyle(Tokens.Text.secondary.color)
                    }
                }
                if !results.isEmpty {
                    Text(CalendarCopy.searchHint)
                        .font(Tokens.Typography.caption.font)
                        .foregroundStyle(Tokens.Text.secondary.color)
                        .listRowSeparator(.hidden)
                }
            }
            .listStyle(.plain)
            .scrollDismissesKeyboard(.interactively)
        }
        .background(Tokens.Canvas.background.color)
        .onAppear { focused = true }
        .task(id: query) {
            try? await Task.sleep(for: .milliseconds(200))
            guard !Task.isCancelled else { return }
            results = await store.search(query)
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.hidden)
    }

    private func row(_ item: CalendarItem) -> some View {
        HStack(spacing: Tokens.Space.medium) {
            Circle().fill(CalendarItemStyle.hue(item).rail.color).frame(width: 7, height: 7)
            VStack(alignment: .leading, spacing: 2) {
                Text(item.title)
                    .font(Tokens.Typography.body.font)
                    .foregroundStyle(Tokens.Text.primary.color)
                Text(Self.detail(item))
                    .font(Tokens.Typography.caption.font)
                    .foregroundStyle(Tokens.Text.secondary.color)
            }
        }
        .frame(minHeight: Tokens.Size.minimumHitArea)
        .accessibilityElement(children: .combine)
    }

    /// "Fri, Sep 25 · Task · memrynote Launch" (Paper 11).
    static func detail(_ item: CalendarItem) -> String {
        var parts = [CalendarSheetText.when(item)]
        if item.visualType != "event", item.visualType != "external_event" {
            parts.append(CalendarCopy.visualType(item.visualType))
        }
        if !item.source.title.isEmpty { parts.append(item.source.title) }
        return parts.joined(separator: " · ")
    }

    /// This week / Later / Earlier, in the proximity order search returned.
    private var groups: [(title: String, items: [CalendarItem])] {
        let today = store.today
        let weekStart = CalendarDates.startOfWeek(today, weekStartsOn: store.weekStartsOn)
        let weekEnd = CalendarDates.addDays(weekStart, 6)
        var thisWeek: [CalendarItem] = [], later: [CalendarItem] = [], earlier: [CalendarItem] = []
        for item in results {
            let day = CalendarDates.spanStart(item)
            if day >= weekStart, day <= weekEnd { thisWeek.append(item) } else if day > weekEnd { later.append(item) } else { earlier.append(item) }
        }
        return [(CalendarCopy.thisWeek, thisWeek), (CalendarCopy.later, later), (CalendarCopy.earlier, earlier)].filter { !$0.items.isEmpty }
    }
}
