import MemryCore

// Desktop parity for task, project and task-reminder events
// (`main/tasks/publisher.ts`, `ipc/tasks-handlers.ts`, `reminder-picker.tsx`).
//
// A task write's `TaskChange` names what it did: the tasks it created and
// deleted, and per changed task the fields it changed. Counting from it in
// `TasksStore.perform` and `CalendarStore.taskWrite` covers every caller once,
// the way desktop's domain publisher does.

/// How a reminder time was picked (desktop `reminder_created.source`).
enum TaskReminderOrigin: Equatable, Sendable {
    /// One of `TaskReminderPresets`' fixed ids.
    case preset(String)
    case custom
}

enum TasksTelemetry {
    /// Task fields a user edit changes. Bookkeeping (`position`, clocks,
    /// `modifiedAt`) and anything a newer core adds are not counted, so a
    /// `changed_fields` value is always built from this list.
    private static let editableFields: Set<String> = [
        "title", "description", "projectId", "statusId", "parentId", "priority",
        "dueDate", "dueTime", "startDate", "repeatConfig", "repeatFrom",
        "completedAt", "archivedAt", "tags", "linkedNoteIds", "linkedCanvasIds", "fields"
    ]

    nonisolated static func track(_ change: TaskChange) {
        for _ in change.created {
            Telemetry.shared.track(.taskCreated, surface: .tasks, action: "created", objectType: "task", result: .success)
        }
        for prior in change.changed {
            let fields = Set(prior.fields.map(\.field)).intersection(editableFields)
            guard !fields.isEmpty else { continue }
            if let completedAt = prior.fields.first(where: { $0.field == "completedAt" }), completedAt.json == "null" {
                Telemetry.shared.track(.taskCompleted, surface: .tasks, action: "completed", objectType: "task", result: .success)
                continue
            }
            if fields.contains("completedAt") {
                Telemetry.shared.track(.taskReopened, surface: .tasks, action: "reopened", objectType: "task", result: .success)
            }
            Telemetry.shared.track(
                .taskUpdated, surface: .tasks, action: "updated", objectType: "task", result: .success,
                dimension: (.changedFields, changedFields(fields))
            )
        }
        for _ in change.deleted {
            Telemetry.shared.track(.taskDeleted, surface: .tasks, action: "deleted", objectType: "task", result: .success)
        }
    }

    /// Desktop's `changedFieldsDimension`: the names sorted and joined.
    nonisolated static func changedFields(_ fields: Set<String>) -> String {
        String(fields.sorted().joined(separator: "_").prefix(64))
    }

    // MARK: Projects

    nonisolated static func projectCreated() {
        Telemetry.shared.track(.projectCreated, surface: .tasks, action: "created", objectType: "project", result: .success)
    }

    nonisolated static func projectUpdated(_ fields: Set<String>) {
        Telemetry.shared.track(
            .projectUpdated, surface: .tasks, action: "updated", objectType: "project", result: .success,
            dimension: (.changedFields, changedFields(fields))
        )
    }

    /// The editor's save: desktop counts the keys the form sent.
    nonisolated static func projectSaved(_ draft: ProjectDraft) {
        var fields: Set<String> = ["name"]
        if draft.description != nil { fields.insert("description") }
        if draft.color != nil { fields.insert("color") }
        if draft.icon != nil { fields.insert("icon") }
        if draft.statuses != nil { fields.insert("statuses") }
        projectUpdated(fields)
    }

    nonisolated static func projectArchived(_ archived: Bool) {
        if archived {
            Telemetry.shared.track(
                .projectArchived, surface: .tasks, action: "archived", objectType: "project", result: .success,
                dimension: (.changedFields, "archivedAt")
            )
        } else {
            projectUpdated(["archivedAt"])
        }
    }

    nonisolated static func projectDeleted() {
        Telemetry.shared.track(.projectDeleted, surface: .tasks, action: "deleted", objectType: "project", result: .success)
    }

    nonisolated static func projectOpened() {
        Telemetry.shared.track(.projectOpened, surface: .projects, action: "opened")
    }

    // MARK: Reminders

    nonisolated static func reminderCreated(_ origin: TaskReminderOrigin?, surface: TelemetrySurface = .tasks) {
        switch origin {
        case let .preset(id):
            Telemetry.shared.track(.reminderCreated, surface: surface, action: "created", source: "preset", dimension: (.value, id))
        case .custom:
            Telemetry.shared.track(.reminderCreated, surface: surface, action: "created", source: "custom")
        case nil:
            Telemetry.shared.track(.reminderCreated, surface: surface, action: "created")
        }
    }

    nonisolated static func reminderDeleted() {
        Telemetry.shared.track(.reminderDeleted, surface: .tasks, action: "deleted")
    }
}
