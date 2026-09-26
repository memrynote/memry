import MemryCore
import SwiftUI

// Spec 007 CL041 (artboard 13). The new / edit event sheet: title, All-day
// (desktop's date conversion), Starts / Ends with the duration, the target
// calendar grouped by provider with the default, the project, the colour
// (default + 11), notes / URL. The checkmark saves; a save error keeps the
// sheet open with the message; a failed project link keeps the event and
// says so (desktop `calendar-event-form.tsx`, `pages/calendar.tsx`).

struct CalendarEditorRequest: Identifiable, Equatable {
    let id = UUID()
    var eventId: String?
    var title = ""
    var notes = ""
    var location: String?
    var isAllDay = false
    var start: Date
    var end: Date
    var targetCalendarId: String?
    var color: String?
    var projectId: String?

    /// `createDraftFromAnchor` / a grid selection.
    static func new(day: String, startMinute: Int, endMinute: Int, allDay: Bool, lastDay: String? = nil) -> Self {
        let base = CalendarDates.start(of: day)
        let start = allDay ? base : base.addingTimeInterval(TimeInterval(startMinute * 60))
        let end = allDay ? CalendarDates.start(of: lastDay ?? day) : base.addingTimeInterval(TimeInterval(endMinute * 60))
        return CalendarEditorRequest(isAllDay: allDay, start: start, end: end)
    }

    /// `createDraftFromItem` + the record's own fields.
    static func edit(_ record: CalendarEventRecord) -> Self {
        let start = CalendarDates.date(record.startAt) ?? Date()
        var end = record.endAt.flatMap(CalendarDates.date) ?? start.addingTimeInterval(3_600)
        // All-day ends are exclusive midnights; the form shows the last day.
        if record.isAllDay, end > start { end = end.addingTimeInterval(-86_400) }
        return CalendarEditorRequest(
            eventId: record.id, title: record.title, notes: record.description ?? "",
            location: record.location, isAllDay: record.isAllDay, start: start, end: end,
            targetCalendarId: record.targetCalendarId, color: record.color
        )
    }

    /// `toCreatePayload`: all-day days become local midnights, the end day
    /// exclusive (the next midnight), as desktop's `localInputToIso` writes.
    var startIso: String {
        CalendarDates.iso(isAllDay ? CalendarDates.start(of: CalendarDates.key(start)) : start)
    }

    var endIso: String {
        if isAllDay {
            return CalendarDates.iso(CalendarDates.start(of: CalendarDates.addDays(CalendarDates.key(max(end, start)), 1)))
        }
        return CalendarDates.iso(max(end, start))
    }
}

struct CalendarEventEditor: View {
    @Bindable var store: CalendarStore
    @State var request: CalendarEditorRequest
    @State private var saving = false
    @State private var error: String?
    @State private var initialProject: String?
    @Environment(\.dismiss) private var dismiss
    @FocusState private var titleFocused: Bool

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField(CalendarCopy.titlePlaceholder, text: $request.title)
                        .font(Tokens.Typography.body.font.weight(.semibold))
                        .focused($titleFocused)
                        .accessibilityIdentifier("calendar.editor.title")
                    if let error {
                        Text(error)
                            .font(Tokens.Typography.caption.font)
                            .foregroundStyle(Tokens.Interaction.destructive.color)
                    }
                }
                Section {
                    Toggle(CalendarCopy.allDay, isOn: $request.isAllDay)
                        .accessibilityIdentifier("calendar.editor.allDay")
                    DatePicker(CalendarCopy.starts, selection: startBinding, displayedComponents: components)
                    DatePicker(CalendarCopy.ends, selection: $request.end, in: request.start..., displayedComponents: components)
                    if !request.isAllDay {
                        LabeledContent(CalendarCopy.durationLabel, value: CalendarCopy.duration(minutes: max(Int(request.end.timeIntervalSince(request.start) / 60), 0)))
                    }
                }
                Section {
                    CalendarTargetPicker(store: store, selection: $request.targetCalendarId)
                    CalendarEditorProjectRow(store: store, projectId: $request.projectId)
                    CalendarColorPicker(selection: $request.color)
                }
                Section {
                    TextField(CalendarCopy.notesPlaceholder, text: $request.notes, axis: .vertical)
                        .lineLimit(3 ... 8)
                        .accessibilityIdentifier("calendar.editor.notes")
                }
            }
            .navigationTitle(request.eventId == nil ? CalendarCopy.newEventTitle : CalendarCopy.editEventTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button { dismiss() } label: { Image(systemName: "xmark") }.accessibilityLabel(CalendarCopy.cancel)
                }
                ToolbarItem(placement: .confirmationAction) {
                    SheetConfirmButton(label: CalendarCopy.save, isEnabled: canSave) { Task { await save() } }
                        .accessibilityIdentifier("calendar.editor.save")
                }
            }
        }
        .presentationDetents([.large])
        .onAppear {
            if request.title.isEmpty { titleFocused = true }
            initialProject = request.projectId
        }
        .task { await loadProject() }
    }

    private var components: DatePickerComponents { request.isAllDay ? .date : [.date, .hourAndMinute] }
    private var canSave: Bool { !saving && !request.title.trimmingCharacters(in: .whitespaces).isEmpty }

    /// Moving the start keeps the duration, as desktop's form does.
    private var startBinding: Binding<Date> {
        Binding(get: { request.start }, set: { next in
            let duration = request.end.timeIntervalSince(request.start)
            request.start = next
            request.end = next.addingTimeInterval(max(duration, 0))
        })
    }

    private func loadProject() async {
        guard let id = request.eventId else { return }
        let core = store.core
        let linked = await store.read { try core.linkedProjects(eventId: id) } ?? []
        request.projectId = linked.first { !$0.isArchived }?.id
        initialProject = request.projectId
    }

    private func save() async {
        saving = true
        defer { saving = false }
        let draft = request
        let title = draft.title.trimmingCharacters(in: .whitespacesAndNewlines)
        let notes = draft.notes.trimmingCharacters(in: .whitespacesAndNewlines)
        let record: CalendarEventRecord?
        if let id = draft.eventId {
            let changes = CalendarEventChanges(
                title: title,
                description: notes.isEmpty ? .clear : .set(value: notes),
                location: .keep,
                startAt: draft.startIso,
                endAt: .set(value: draft.endIso),
                timezone: TimeZone.current.identifier,
                isAllDay: draft.isAllDay,
                targetCalendarId: draft.targetCalendarId.map { .set(value: $0) } ?? .clear,
                color: draft.color.map { .set(value: $0) } ?? .clear
            )
            record = await store.write { try $0.updateEvent(id: id, changes: changes) }
        } else {
            let create = CalendarEventDraft(
                title: title, description: notes.isEmpty ? nil : notes, location: nil,
                startAt: draft.startIso, endAt: draft.endIso, timezone: TimeZone.current.identifier,
                isAllDay: draft.isAllDay, targetCalendarId: draft.targetCalendarId, color: draft.color
            )
            record = await store.write { try $0.createEvent(draft: create) }
        }
        guard let record else {
            error = draft.eventId == nil ? CalendarCopy.couldNotCreate : CalendarCopy.couldNotSave
            store.clearFailure()
            return
        }
        // The event is saved; a project link that fails keeps it and says so.
        if draft.projectId != initialProject, !(await store.relink(eventId: record.id, from: initialProject, to: draft.projectId)) {
            store.showToast(CalendarCopy.projectUpdateFailed)
        }
        dismiss()
    }
}

extension CalendarCopy {
    static let durationLabel = "Duration"
}
