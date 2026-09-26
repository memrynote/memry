import MemryCore
import SwiftUI

// Spec 007 CL042/CL051 (artboards 14, 19). Every item opens a sheet (00 rule
// 2). This routes by item type and draws the two event sheets: the editable
// memrynote event (kind + calendar header, … menu, prominent checkmark to
// edit, time line, set fields as pills, Join, read-only attendees, reminders,
// visibility) and the read-only one (badge, recurrence, alerts, call + phone
// PIN, location, attendees with Show more, description with links, "change it
// in …" footer).

struct CalendarItemSheet: View {
    @Bindable var store: CalendarStore
    let item: CalendarItem
    let browse: VaultBrowseViewModel?
    let delete: (CalendarItem) -> Void
    let addToProject: (CalendarItem) -> Void

    var body: some View {
        switch item.sourceType {
        case "event": CalendarEventSheet(store: store, item: item, delete: delete, addToProject: addToProject)
        case "external_event": CalendarReadOnlySheet(store: store, item: item)
        case "task": CalendarTaskSheet(store: store, item: item)
        case "note", "note_date": CalendarNoteSheet(store: store, item: item)
        case "inbox_snooze": CalendarSnoozeSheet(store: store, item: item)
        default: CalendarReminderSheet(store: store, item: item)
        }
    }
}

/// The sheet header: kind · calendar, then the title.
struct CalendarSheetHeader: View {
    let item: CalendarItem
    let kind: String
    var badge: String?

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.tight) {
            HStack(spacing: Tokens.Space.small) {
                Circle().fill(CalendarItemStyle.hue(item).rail.color).frame(width: 8, height: 8)
                Text([kind, item.source.title].filter { !$0.isEmpty }.joined(separator: " · "))
                    .font(Tokens.Typography.caption.font)
                    .foregroundStyle(Tokens.Text.secondary.color)
                if let badge {
                    Text(badge)
                        .font(Tokens.Typography.caption.font.weight(.semibold))
                        .foregroundStyle(Tokens.Text.secondary.color)
                        .padding(.horizontal, Tokens.Space.small)
                        .padding(.vertical, 2)
                        .background(Tokens.Canvas.surfaceActive.color, in: .capsule)
                        .accessibilityIdentifier("calendar.sheet.readOnly")
                }
            }
            Text(item.title)
                .font(Tokens.Typography.sectionTitle.font)
                .foregroundStyle(Tokens.Text.primary.color)
                .accessibilityAddTraits(.isHeader)
            Text(CalendarSheetText.when(item))
                .font(Tokens.Typography.supporting.font)
                .foregroundStyle(Tokens.Text.secondary.color)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

enum CalendarSheetText {
    /// "Thu, Sep 24 · 10:00 – 11:30", all-day items read in UTC with an
    /// exclusive end (desktop `whenLabel`).
    static func when(_ item: CalendarItem) -> String {
        if item.isAllDay {
            var utc = Date.FormatStyle.dateTime.weekday(.abbreviated).month(.abbreviated).day()
            utc.timeZone = TimeZone(identifier: "UTC") ?? .current
            let start = item.startDate
            let last = item.endDate.map { $0.addingTimeInterval(-86_400) } ?? start
            return last > start ? "\(start.formatted(utc)) – \(last.formatted(utc))" : start.formatted(utc)
        }
        let day = item.startDate.formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day())
        guard let end = item.endDate else { return "\(day) · \(CalendarItemStyle.time(item.startDate))" }
        return "\(day) · \(CalendarItemStyle.time(item.startDate)) – \(CalendarItemStyle.time(end))"
    }
}

struct CalendarEventSheet: View {
    @Bindable var store: CalendarStore
    let item: CalendarItem
    let delete: (CalendarItem) -> Void
    let addToProject: (CalendarItem) -> Void
    @State private var record: CalendarEventRecord?
    @State private var projects: [CalendarLinkedProject] = []
    @State private var editing: CalendarEditorRequest?
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    var body: some View {
        NavigationStack {
            List {
                Section { CalendarSheetHeader(item: item, kind: CalendarCopy.eventKind) }
                    .listRowBackground(Color.clear)
                if let record {
                    pills(record)
                    if let join = CalendarEventMetadata.joinURL(record.conferenceDataJson) {
                        Section {
                            Button { openURL(join) } label: {
                                Label(CalendarCopy.joinMeeting, systemImage: "video.fill").frame(maxWidth: .infinity)
                            }
                            .buttonStyle(.glassProminent)
                            .tint(Tokens.Tint.base.color)
                            .foregroundStyle(Tokens.Tint.foreground.color)
                            .accessibilityIdentifier("calendar.sheet.join")
                        }
                        .listRowBackground(Color.clear)
                    }
                    CalendarEventMetadataSections(
                        attendeesJson: record.attendeesJson, remindersJson: record.remindersJson,
                        visibility: record.visibility, description: record.description
                    )
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button { dismiss() } label: { Image(systemName: "xmark") }.accessibilityLabel(CalendarCopy.close)
                }
                ToolbarItemGroup(placement: .confirmationAction) {
                    Menu {
                        Button { addToProject(item) } label: { Label(CalendarCopy.addToProject, systemImage: "folder") }
                        Button(role: .destructive) { delete(item) } label: { Label(CalendarCopy.delete, systemImage: "trash") }
                    } label: { Image(systemName: "ellipsis") }
                        .accessibilityLabel(CalendarCopy.moreActions)
                        .accessibilityIdentifier("calendar.sheet.more")
                    SheetConfirmButton(label: CalendarCopy.editEventTitle, isEnabled: record != nil) {
                        if let record { editing = .edit(record) }
                    }
                    .accessibilityIdentifier("calendar.sheet.edit")
                }
            }
            .sheet(item: $editing) { request in
                CalendarEventEditor(store: store, request: request)
                    .onDisappear { Task { await load() } }
            }
        }
        .presentationDetents([.medium, .large])
        .task { await load() }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("calendar.sheet.event")
    }

    private func load() async {
        let core = store.core
        let id = item.sourceId
        record = await store.read { try core.event(id: id) } ?? nil
        projects = await store.read { try core.linkedProjects(eventId: id) } ?? []
    }

    /// Pills for the fields that are set (location, colour, project).
    @ViewBuilder
    private func pills(_ record: CalendarEventRecord) -> some View {
        let values = [record.location, record.color.map(CalendarCopy.colorName), projects.first?.name]
            .compactMap { $0 }.filter { !$0.isEmpty }
        if !values.isEmpty {
            Section {
                ScrollView(.horizontal) {
                    HStack(spacing: Tokens.Space.small) {
                        ForEach(values, id: \.self) { value in
                            Text(value)
                                .font(Tokens.Typography.supporting.font)
                                .padding(.horizontal, Tokens.Space.medium)
                                .frame(minHeight: Tokens.Size.pill)
                                .background(Tokens.Canvas.surface.color, in: .capsule)
                        }
                    }
                }
                .scrollIndicators(.hidden)
            }
            .listRowBackground(Color.clear)
        }
    }
}
