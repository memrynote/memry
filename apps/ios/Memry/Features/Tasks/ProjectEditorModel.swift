import Foundation
import MemryCore
import Observation
import SwiftUI

// TP052. The project editor's form state, after desktop's `project-modal.tsx`
// and `status-editor.tsx`: the form, its unsaved-changes check, the editor's
// validation (`validateProject`, `canDeleteStatus` in `data/tasks-data.ts`)
// and the draft it saves.
//
// The editor rules are renderer rules on desktop too: the core accepts any
// list of two or more valid statuses (a desktop payload written without the
// editor rules must stay editable), so they live with the form, not the core.

/// Desktop's project and status palette (`projectColors` / `statusColors`).
/// Stored values, written to the wire as-is.
enum ProjectPalette {
    struct Swatch: Equatable, Sendable, Identifiable {
        let id: String
        let hex: String
    }

    static let swatches: [Swatch] = [
        Swatch(id: "gray", hex: "#6b7280"),
        Swatch(id: "red", hex: "#ef4444"),
        Swatch(id: "orange", hex: "#f59e0b"),
        Swatch(id: "yellow", hex: "#eab308"),
        Swatch(id: "green", hex: "#10b981"),
        Swatch(id: "teal", hex: "#14b8a6"),
        Swatch(id: "blue", hex: "#3b82f6"),
        Swatch(id: "indigo", hex: "#6366f1"),
        Swatch(id: "purple", hex: "#8b5cf6"),
        Swatch(id: "pink", hex: "#ec4899")
    ]

    /// `createDefaultProject().color`.
    static let defaultProjectColor = "#6366f1"
    /// `createDefaultStatus().color`.
    static let defaultStatusColor = "#6b7280"

    /// The swatch a stored colour matches, case-insensitively.
    static func swatch(for hex: String) -> Swatch? {
        swatches.first { $0.hex.caseInsensitiveCompare(hex) == .orderedSame }
    }
}

/// How a project icon is stored and shown. Desktop stores a raw emoji, an
/// `icon:<HugeIconsName>` value or a legacy lucide name (`project-icon.tsx`);
/// the phone writes emoji only (the one shape every desktop renders) and
/// shows every other value as a folder symbol.
enum ProjectIconValue {
    /// `DEFAULT_ICON` in `project-modal.tsx`: what create and "Remove" write.
    static let defaultIcon = "Folder"

    /// The emoji to draw, when the stored value is one (`containsNonAscii`).
    static func emoji(_ icon: String?) -> String? {
        guard let icon, !icon.isEmpty, icon.unicodeScalars.contains(where: { !$0.isASCII }) else { return nil }
        return icon
    }

    /// The last emoji typed into the icon field, or `nil` for plain text.
    static func sanitize(_ typed: String) -> String? {
        guard let last = typed.last else { return nil }
        let text = String(last)
        return emoji(text)
    }
}

/// One status row of the editor. `localId` keys the row; `id` is the stored
/// status id, `nil` for a status added here.
struct ProjectStatusRow: Equatable, Sendable, Identifiable {
    let localId: UUID
    var statusId: String?
    var name: String
    var color: String
    /// `todo`, `in_progress` or `done`.
    var statusType: String

    var id: UUID { localId }

    init(statusId: String? = nil, name: String = "", color: String = ProjectPalette.defaultStatusColor,
         statusType: String = "todo") {
        localId = UUID()
        self.statusId = statusId
        self.name = name
        self.color = color
        self.statusType = statusType
    }
}

/// Everything the editor edits; `Equatable` is the unsaved-changes check.
struct ProjectForm: Equatable, Sendable {
    var name: String
    var description: String
    var icon: String
    var color: String
    var statuses: [ProjectStatusRow]
}

@MainActor
@Observable
final class ProjectEditorModel {
    /// Desktop's editor limits (`maxLength` on the inputs).
    static let maxNameLength = 50
    static let maxDescriptionLength = 200
    static let maxStatusNameLength = 30
    static let statusTypes = ["todo", "in_progress", "done"]

    let projectId: String?
    let isInbox: Bool
    let initial: ProjectForm
    var form: ProjectForm

    /// `nil` creates a project with desktop's defaults.
    init(project: ProjectItem?) {
        projectId = project?.id
        isInbox = project?.isInbox ?? false
        let form: ProjectForm
        if let project {
            form = ProjectForm(
                name: project.name,
                description: project.description ?? "",
                icon: project.icon ?? ProjectIconValue.defaultIcon,
                color: project.color,
                statuses: project.statuses.sorted { $0.position < $1.position }.map {
                    ProjectStatusRow(statusId: $0.id, name: $0.name, color: $0.color, statusType: $0.statusType)
                }
            )
        } else {
            form = ProjectForm(
                name: "",
                description: "",
                icon: ProjectIconValue.defaultIcon,
                color: ProjectPalette.defaultProjectColor,
                statuses: [
                    ProjectStatusRow(name: "To Do", color: "#6b7280", statusType: "todo"),
                    ProjectStatusRow(name: "In Progress", color: "#F59E0B", statusType: "in_progress"),
                    ProjectStatusRow(name: "Done", color: "#10b981", statusType: "done")
                ]
            )
        }
        initial = form
        self.form = form
    }

    var isEditing: Bool { projectId != nil }
    var hasChanges: Bool { form != initial }
    /// Desktop: `isEditMode && !project.isDefault`.
    var canDeleteProject: Bool { isEditing && !isInbox }

    // MARK: Validation (`validateProject`)

    var nameError: String? {
        if form.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return TasksCopy.Projects.nameRequired
        }
        if form.name.count > Self.maxNameLength { return TasksCopy.Projects.nameTooLong }
        return nil
    }

    var statusesError: String? {
        let statuses = form.statuses
        if statuses.count < 2 { return TasksCopy.Projects.minStatuses }
        if !statuses.contains(where: { $0.statusType == "todo" }) {
            return TasksCopy.Projects.needsTodoForNewTasks
        }
        if !statuses.contains(where: { $0.statusType == "done" }) {
            return TasksCopy.Projects.needsDoneForCompletedTasks
        }
        let names = statuses.map { $0.name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
        if names.contains(where: \.isEmpty) { return TasksCopy.Projects.statusNameRequired }
        if Set(names).count != names.count { return TasksCopy.Projects.statusNamesUnique }
        return nil
    }

    var isValid: Bool { nameError == nil && statusesError == nil }

    // MARK: Status editing

    /// `canDeleteStatus`: the reason a status must stay, or `nil`.
    func deleteBlocker(_ row: ProjectStatusRow) -> String? {
        let statuses = form.statuses
        if statuses.count <= 2 { return TasksCopy.Projects.minStatuses }
        if row.statusType == "todo", statuses.filter({ $0.statusType == "todo" }).count <= 1 {
            return TasksCopy.Projects.needsTodoStatus
        }
        if row.statusType == "done", statuses.filter({ $0.statusType == "done" }).count <= 1 {
            return TasksCopy.Projects.needsDoneStatus
        }
        return nil
    }

    func addStatus() {
        form.statuses.append(ProjectStatusRow())
    }

    func deleteStatus(_ row: ProjectStatusRow) {
        guard deleteBlocker(row) == nil else { return }
        form.statuses.removeAll { $0.localId == row.localId }
    }

    func deleteStatuses(at offsets: IndexSet) {
        for row in offsets.map({ form.statuses[$0] }) { deleteStatus(row) }
    }

    func moveStatuses(from source: IndexSet, to destination: Int) {
        form.statuses.move(fromOffsets: source, toOffset: destination)
    }

    /// Moves one row up (`-1`) or down (`+1`), for VoiceOver.
    func moveStatus(_ row: ProjectStatusRow, by offset: Int) {
        guard let index = form.statuses.firstIndex(where: { $0.localId == row.localId }) else { return }
        let target = index + offset
        guard form.statuses.indices.contains(target) else { return }
        form.statuses.swapAt(index, target)
    }

    // MARK: Limits

    /// Keeps the typed text inside desktop's `maxLength`.
    func clampInputs() {
        if form.name.count > Self.maxNameLength { form.name = String(form.name.prefix(Self.maxNameLength)) }
        if form.description.count > Self.maxDescriptionLength {
            form.description = String(form.description.prefix(Self.maxDescriptionLength))
        }
        for index in form.statuses.indices where form.statuses[index].name.count > Self.maxStatusNameLength {
            form.statuses[index].name = String(form.statuses[index].name.prefix(Self.maxStatusNameLength))
        }
    }

    // MARK: Saving

    /// The draft the core saves. Create always sends the form's statuses, as
    /// desktop's `addProject` does; an update sends `nil` for an untouched
    /// list, which leaves the stored statuses alone.
    var draft: ProjectDraft {
        let description = form.description.trimmingCharacters(in: .whitespacesAndNewlines)
        let statuses: [StatusDraft]? = isEditing && form.statuses == initial.statuses
            ? nil
            : form.statuses.enumerated().map { order, row in
                StatusDraft(
                    id: row.statusId,
                    name: row.name.trimmingCharacters(in: .whitespacesAndNewlines),
                    color: row.color,
                    statusType: row.statusType,
                    order: Int64(order)
                )
            }
        return ProjectDraft(
            name: form.name.trimmingCharacters(in: .whitespacesAndNewlines),
            description: description.isEmpty ? nil : description,
            color: form.color,
            icon: form.icon,
            statuses: statuses
        )
    }

    /// Creates or updates through the store; `true` when saved.
    func save(in store: TasksStore) async -> Bool {
        guard isValid else { return false }
        let draft = draft
        if let projectId {
            return await store.updateProject(projectId, draft: draft)
        }
        return await store.createProject(draft) != nil
    }
}
