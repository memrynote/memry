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

    /// Paper 14: "Thu, Sep 24 · 16:00 – 17:30 · 1h 30m".
    static func whenWithDuration(_ item: CalendarItem) -> String {
        guard !item.isAllDay, let end = item.endDate else { return when(item) }
        let minutes = Int(end.timeIntervalSince(item.startDate) / 60)
        return "\(when(item)) · \(CalendarCopy.duration(minutes: max(minutes, 0)))"
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
    @State private var title = ""
    @State private var saving = false
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    /// Paper 14: the title edits in place, set fields show as pills, + opens
    /// the rest (the full sheet, 13); the checkmark saves.
    var body: some View {
        NavigationStack {
            List {
                Section { header }
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets(top: 0, leading: Tokens.Space.inset, bottom: 0, trailing: Tokens.Space.inset))
                if let record {
                    if let join = CalendarEventMetadata.joinURL(record.conferenceDataJson) {
                        Section {
                            HStack(spacing: Tokens.Space.medium) {
                                Image(systemName: "video").foregroundStyle(Tokens.Text.secondary.color)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(CalendarEventMetadata.conferenceName(record.conferenceDataJson) ?? CalendarCopy.videoCall)
                                        .foregroundStyle(Tokens.Text.primary.color)
                                    Text(join.host() ?? join.absoluteString)
                                        .font(Tokens.Typography.caption.font)
                                        .foregroundStyle(Tokens.Text.secondary.color)
                                        .lineLimit(1)
                                }
                                Spacer()
                                Button(CalendarCopy.join) { openURL(join) }
                                    .buttonStyle(.glassProminent)
                                    .tint(Tokens.Calendar.indigo.rail.color)
                                    .accessibilityLabel(CalendarCopy.joinMeeting)
                                    .accessibilityIdentifier("calendar.sheet.join")
                            }
                        }
                    }
                    CalendarEventMetadataSections(
                        attendeesJson: record.attendeesJson, remindersJson: record.remindersJson,
                        visibility: record.visibility, description: record.description
                    )
                }
            }
            .listSectionSpacing(Tokens.Space.medium)
            .contentMargins(.top, 0, for: .scrollContent)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button { dismiss() } label: {
                        Image(systemName: "xmark").foregroundStyle(Tokens.Text.primary.color)
                    }
                    .accessibilityLabel(CalendarCopy.close)
                }
                ToolbarItem(placement: .principal) {
                    HStack(spacing: Tokens.Space.tight + 2) {
                        Circle().fill(CalendarItemStyle.hue(item).rail.color).frame(width: 7, height: 7)
                        Text(CalendarCopy.eventKind).font(Tokens.Typography.body.font.weight(.semibold))
                    }
                    .accessibilityElement(children: .combine)
                }
                ToolbarItemGroup(placement: .confirmationAction) {
                    Menu {
                        Button { addToProject(item) } label: { Label(CalendarCopy.addToProject, systemImage: "folder") }
                        Button(role: .destructive) { delete(item) } label: { Label(CalendarCopy.delete, systemImage: "trash") }
                    } label: {
                        Image(systemName: "ellipsis").foregroundStyle(Tokens.Text.primary.color)
                    }
                    .accessibilityLabel(CalendarCopy.moreActions)
                    .accessibilityIdentifier("calendar.sheet.more")
                    SheetConfirmButton(label: CalendarCopy.save, isEnabled: record != nil && !saving) {
                        Task { await save() }
                    }
                    .accessibilityIdentifier("calendar.sheet.save")
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

    private var header: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.small) {
            TextField(CalendarCopy.titlePlaceholder, text: $title, axis: .vertical)
                .font(Tokens.Typography.sectionTitle.font)
                .foregroundStyle(Tokens.Text.primary.color)
                .submitLabel(.done)
                .accessibilityIdentifier("calendar.sheet.title")
            Text(CalendarSheetText.whenWithDuration(item))
                .font(Tokens.Typography.supporting.font)
                .foregroundStyle(Tokens.Text.secondary.color)
            TaskFlowLayout(horizontal: Tokens.Space.small, vertical: Tokens.Space.small) {
                ForEach(pills, id: \.text) { pill in
                    Button { openEditor() } label: {
                        HStack(spacing: Tokens.Space.tight + 2) {
                            if let color = pill.color { Circle().fill(color).frame(width: 7, height: 7) }
                            Text(pill.text)
                        }
                        .font(Tokens.Typography.supporting.font)
                        .foregroundStyle(Tokens.Text.primary.color)
                        .padding(.horizontal, Tokens.Space.medium)
                        .frame(minHeight: Tokens.Size.pill)
                        .background(Tokens.Canvas.surface.color, in: .capsule)
                        .frame(minHeight: Tokens.Size.minimumHitArea)
                    }
                    .buttonStyle(.plain)
                }
                Button { openEditor() } label: {
                    Image(systemName: "plus")
                        .font(Tokens.Typography.supporting.font.weight(.semibold))
                        .foregroundStyle(Tokens.Text.primary.color)
                        .frame(width: Tokens.Size.pill, height: Tokens.Size.pill)
                        .background(Tokens.Canvas.surface.color, in: .circle)
                        .frame(minWidth: Tokens.Size.minimumHitArea, minHeight: Tokens.Size.minimumHitArea)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(CalendarCopy.moreFields)
                .accessibilityIdentifier("calendar.sheet.moreFields")
            }
        }
        .padding(.bottom, Tokens.Space.small)
    }

    /// Calendar, project, colour and place, each only when set (Paper 14).
    private var pills: [(text: String, color: Color?)] {
        var result: [(text: String, color: Color?)] = []
        if !item.source.title.isEmpty { result.append((item.source.title, CalendarItemStyle.hue(item).rail.color)) }
        if let project = projects.first {
            result.append((project.name, project.color.flatMap { Tokens.Calendar.hue(hex: $0)?.rail.color } ?? Tokens.Text.tertiary.color))
        }
        // Events store Google's colour name ("tomato"); older rows may hold a hex.
        if let color = record?.color {
            let named = Tokens.Calendar.eventColors.first { $0.name == color }
                .map { Color(uiColor: AdaptiveColor.RGB(hex: $0.hex).uiColor) }
            if let swatch = named ?? Tokens.Calendar.hue(hex: color)?.rail.color {
                result.append((CalendarCopy.colorName(color), swatch))
            }
        }
        if let location = record?.location, !location.isEmpty { result.append((location, nil)) }
        return result
    }

    private func openEditor() {
        if let record { editing = .edit(record) }
    }

    private func load() async {
        let core = store.core
        let id = item.sourceId
        record = await store.read { try core.event(id: id) } ?? nil
        projects = await store.read { try core.linkedProjects(eventId: id) } ?? []
        if let record { title = record.title }
    }

    private func save() async {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let record, !trimmed.isEmpty, trimmed != record.title else {
            dismiss()
            return
        }
        saving = true
        defer { saving = false }
        let id = record.id
        let changes = CalendarEventChanges(
            title: trimmed, description: .keep, location: .keep, startAt: nil, endAt: .keep,
            timezone: nil, isAllDay: nil, targetCalendarId: .keep, color: .keep
        )
        if await store.write({ try $0.updateEvent(id: id, changes: changes) }) != nil {
            dismiss()
        } else {
            store.clearFailure()
            store.showToast(CalendarCopy.couldNotSave)
        }
    }
}
