import MemryCore
import SwiftUI

// Spec 007 CL041/CL043 (artboards 13, 23). The editor's pickers: target
// calendar grouped by provider with the default, project, colour; and the
// Add to project sheet.

/// `calendar-picker.tsx`: memrynote default, then each provider's writable
/// calendars (Google's primary marked).
struct CalendarTargetPicker: View {
    @Bindable var store: CalendarStore
    @Binding var selection: String?

    var body: some View {
        Picker(CalendarCopy.calendar, selection: $selection) {
            Text(CalendarCopy.memryCalendarDefault).tag(String?.none)
            ForEach(providers, id: \.self) { provider in
                Section(CalendarCopy.providerCalendars(provider)) {
                    ForEach(writable.filter { $0.provider == provider }, id: \.id) { source in
                        Text(source.isPrimary ? "\(source.title) · primary" : source.title).tag(Optional(source.remoteId))
                    }
                }
            }
        }
        .accessibilityIdentifier("calendar.editor.calendar")
    }

    private var writable: [CalendarSourceRecord] {
        store.sources.filter { $0.kind == "calendar" && ($0.provider == "google" || $0.provider == "caldav") && !$0.isMemryManaged }
    }

    private var providers: [String] { Array(Set(writable.map(\.provider))).sorted() }
}

struct CalendarEditorProjectRow: View {
    @Bindable var store: CalendarStore
    @Binding var projectId: String?

    var body: some View {
        Picker(CalendarCopy.project, selection: $projectId) {
            Text(CalendarCopy.noProject).tag(String?.none)
            ForEach((store.tasks?.projects ?? []).filter { $0.archivedAt == nil && !$0.isInbox }, id: \.id) { project in
                Text(project.name).tag(Optional(project.id))
            }
        }
        .accessibilityIdentifier("calendar.editor.project")
    }
}

/// Default + Google's eleven event colours.
struct CalendarColorPicker: View {
    @Binding var selection: String?

    var body: some View {
        Picker(CalendarCopy.color, selection: $selection) {
            Label { Text(CalendarCopy.defaultColor) } icon: { swatch(nil) }.tag(String?.none)
            ForEach(Tokens.Calendar.eventColors, id: \.name) { color in
                Label { Text(CalendarCopy.colorName(color.name)) } icon: { swatch(color.hex) }.tag(Optional(color.name))
            }
        }
        .pickerStyle(.navigationLink)
        .accessibilityIdentifier("calendar.editor.color")
    }

    private func swatch(_ hex: UInt32?) -> some View {
        Circle()
            .fill(hex.map { Color(uiColor: AdaptiveColor.RGB(hex: $0).uiColor) } ?? Tokens.Calendar.indigo.rail.color)
            .frame(width: 14, height: 14)
    }
}

extension CalendarStore {
    /// `event-project-field.tsx` `handleSelect`: link the new project before
    /// unlinking the old, so a half-failed swap leaves one link too many
    /// rather than none. Returns whether both calls landed.
    func relink(eventId: String, from old: String?, to new: String?) async -> Bool {
        guard let core = tasks?.core else { return false }
        do {
            try await CoreExecutor.shared.run {
                if let new { try core.linkToProject(id: new, itemType: "calendar_event", itemId: eventId) }
                if let old { try core.unlinkFromProject(id: old, itemType: "calendar_event", itemId: eventId) }
            }
            await tasks?.refresh()
            scheduleSync()
            return true
        } catch {
            report(error)
            return false
        }
    }
}

/// Artboard 23: search, projects with their dots, the current one checked,
/// Remove from … at the bottom.
struct CalendarProjectPicker: View {
    @Bindable var store: CalendarStore
    let eventId: String
    let title: String
    @State private var query = ""
    @State private var linked: [CalendarLinkedProject] = []
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                ForEach(filtered, id: \.id) { project in
                    Button { Task { await pick(project.id) } } label: {
                        HStack(spacing: Tokens.Space.medium) {
                            Circle().fill(Tokens.Palette.color(project.color)).frame(width: 10, height: 10)
                            Text(project.name).foregroundStyle(Tokens.Text.primary.color)
                            Spacer()
                            if current?.id == project.id {
                                Image(systemName: "checkmark").foregroundStyle(Tokens.Text.tint.color)
                            }
                        }
                        .frame(minHeight: Tokens.Size.minimumHitArea)
                    }
                    .accessibilityAddTraits(current?.id == project.id ? .isSelected : [])
                }
                if let current {
                    Section {
                        Button(CalendarCopy.removeFrom(current.name), role: .destructive) {
                            Task { await pick(nil) }
                        }
                    }
                }
            }
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: CalendarCopy.searchProjects)
            .navigationTitle(CalendarCopy.addToProject)
            .navigationSubtitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button { dismiss() } label: { Image(systemName: "xmark") }.accessibilityLabel(CalendarCopy.close)
                }
            }
        }
        .presentationDetents([.medium, .large])
        .task {
            let core = store.core
            linked = await store.read { try core.linkedProjects(eventId: eventId) } ?? []
        }
    }

    private var current: CalendarLinkedProject? { linked.first { !$0.isArchived } }

    private var filtered: [ProjectItem] {
        let all = (store.tasks?.projects ?? []).filter { $0.archivedAt == nil && !$0.isInbox }
        let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
        return needle.isEmpty ? all : all.filter { $0.name.lowercased().contains(needle) }
    }

    private func pick(_ projectId: String?) async {
        if await store.relink(eventId: eventId, from: current?.id, to: projectId) {
            dismiss()
        } else {
            store.showToast(CalendarCopy.projectUpdateFailed)
        }
    }
}
