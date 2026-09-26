import Foundation
import MemryCore

// Spec 007 CL040-CL045, CL050. Item actions: move / resize with one Undo
// (artboard 16), task completion in place with Undo, promote (18), and the
// task writes the task sheet and the timeline make through the Tasks core.

extension CalendarStore {
    // MARK: Events

    /// A day key and minutes after its local midnight, as an ISO instant.
    func instant(day: String, minute: Int) -> String {
        CalendarDates.iso(CalendarDates.start(of: day).addingTimeInterval(TimeInterval(minute * 60)))
    }

    /// Moves (or resizes when `endMinute` is given) an event or a timed task,
    /// with an Undo toast that puts it back.
    func move(_ item: CalendarItem, day: String, startMinute: Int, endMinute: Int?) async {
        let start = CalendarGridSpace.snap(startMinute)
        switch item.sourceType {
        case "event":
            let oldStart = item.startAt, oldEnd = item.endAt
            let newStart = instant(day: day, minute: start)
            let newEnd: String? = if let endMinute {
                instant(day: day, minute: max(CalendarGridSpace.snap(endMinute), start + 15))
            } else {
                item.endDate.map { end in
                    CalendarDates.iso(CalendarDates.date(newStart).map { $0.addingTimeInterval(end.timeIntervalSince(item.startDate)) } ?? end)
                }
            }
            let id = item.sourceId
            let changes = Self.timeChanges(start: newStart, end: newEnd)
            guard await write({ try $0.updateEvent(id: id, changes: changes) }) != nil else { return }
            let startDate = CalendarDates.date(newStart) ?? item.startDate
            let message = endMinute == nil
                ? CalendarCopy.movedTo(CalendarItemStyle.time(startDate))
                : CalendarCopy.resizedTo(CalendarItemStyle.time(startDate), newEnd.flatMap(CalendarDates.date).map(CalendarItemStyle.time) ?? "")
            showToast(message) { [weak self] in
                let revert = Self.timeChanges(start: oldStart, end: oldEnd)
                await self?.write { try $0.updateEvent(id: id, changes: revert) }
            }
        case "task":
            let time = String(format: "%02d:%02d", start / 60, start % 60)
            await taskWrite(item.sourceId, message: CalendarCopy.taskRescheduled) { core, id in
                try core.setDue(id: id, date: day, time: time)
            }
        default:
            break
        }
    }

    static func timeChanges(start: String, end: String?) -> CalendarEventChanges {
        CalendarEventChanges(
            title: nil, description: .keep, location: .keep, startAt: start,
            endAt: end.map { .set(value: $0) } ?? .clear, timezone: nil, isAllDay: nil,
            targetCalendarId: .keep, color: .keep
        )
    }

    // MARK: Promote (18)

    /// Desktop's rule: skip the alert only when "Don't ask again" is set **and**
    /// the provider's AI read consent is a stored `true`.
    func promoteSkipsConfirm(_ item: CalendarItem) async -> Bool {
        let core = core
        let provider = item.source.provider ?? "google"
        let values = await read {
            (
                try core.setting(path: "calendar.google.promoteConfirmDismissed"),
                try core.setting(path: "calendar.\(provider).agentReadEventsConsent")
            )
        }
        return values?.0 == "true" && values?.1 == "true"
    }

    func isAgentAccessOff(_ item: CalendarItem) async -> Bool {
        let core = core
        let provider = item.source.provider ?? "google"
        let consent = await read { try core.setting(path: "calendar.\(provider).agentReadEventsConsent") }
        return consent != "true"
    }

    func promote(_ item: CalendarItem, dontAskAgain: Bool = false) async -> String? {
        let id = item.sourceId
        let eventId = await write { try $0.promote(externalEventId: id) }
        if eventId != nil, dontAskAgain {
            await write { try $0.setSetting(path: "calendar.google.promoteConfirmDismissed", valueJson: "true") }
        }
        return eventId
    }

    // MARK: Tasks

    /// Completes a task from its chip or sheet, with Undo.
    func completeTask(_ item: CalendarItem) async {
        guard let tasks else { return }
        let now = tasks.localNow()
        await taskWrite(item.sourceId, message: CalendarCopy.taskCompleted) { core, id in
            try core.complete(id: id, localNow: now).change
        }
    }

    /// One task write through the Tasks core, the calendar and the task list
    /// refreshed, an Undo toast that reverts the change.
    func taskWrite(
        _ id: String,
        message: String?,
        _ work: @escaping @Sendable (any TasksProtocol, String) throws -> TaskChange
    ) async {
        guard let tasks else { return }
        let core = tasks.core
        guard let change = await read({ try work(core, id) }) else { return }
        await tasks.refresh()
        await refreshAllWindows()
        scheduleSync()
        guard let message else { return }
        showToast(message) { [weak self] in
            _ = await self?.read { try core.undo(change: change) }
            await tasks.refresh()
            await self?.refreshAllWindows()
            self?.scheduleSync()
        }
    }

    func task(_ id: String) async -> TaskItem? {
        guard let core = tasks?.core else { return nil }
        return await read { try core.get(id: id) } ?? nil
    }
}
