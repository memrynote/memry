import SwiftUI

// TP052. Desktop's `status-editor.tsx`: one row per status with its colour,
// name (≤30) and type; reorder (drag in reorder mode, or VoiceOver's move
// actions); delete, disabled with desktop's reason when the status must stay
// (`canDeleteStatus`); add. The ≥2 / one To Do / one Done / unique-name
// errors show under the list.

private typealias Copy = TasksCopy.Projects

struct ProjectStatusEditor: View {
    @Bindable var model: ProjectEditorModel
    @State private var editMode: EditMode = .inactive

    var body: some View {
        Section {
            ForEach($model.form.statuses) { $row in
                ProjectStatusRowView(row: $row, model: model)
            }
            .onMove { model.moveStatuses(from: $0, to: $1) }
            .onDelete { model.deleteStatuses(at: $0) }
            .environment(\.editMode, $editMode)
            Button {
                model.addStatus()
            } label: {
                Label(Copy.addStatus, systemImage: "plus")
            }
            .frame(minHeight: Tokens.Size.minimumHitArea)
            .accessibilityIdentifier("tasks.projectEditor.addStatus")
        } header: {
            HStack {
                Text(Copy.statuses)
                Spacer()
                Button(editMode.isEditing ? Copy.doneReordering : Copy.reorderProjects) {
                    editMode = editMode.isEditing ? .inactive : .active
                }
                .font(Tokens.Typography.caption.font)
                .frame(minHeight: Tokens.Size.minimumHitArea)
                .accessibilityIdentifier("tasks.projectEditor.reorderStatuses")
            }
        } footer: {
            VStack(alignment: .leading, spacing: Tokens.Space.tight) {
                Text(Copy.statusesHint)
                if let error = model.statusesError {
                    Text(error)
                        .foregroundStyle(Tokens.Interaction.destructive.color)
                        .accessibilityIdentifier("tasks.projectEditor.statusError")
                }
            }
        }
    }
}

private struct ProjectStatusRowView: View {
    @Binding var row: ProjectStatusRow
    let model: ProjectEditorModel

    var body: some View {
        let blocker = model.deleteBlocker(row)
        HStack(spacing: Tokens.Space.small) {
            colorMenu
            TextField(Copy.statusName, text: $row.name)
                .font(Tokens.Typography.body.font)
                .accessibilityIdentifier("tasks.projectEditor.statusName")
            typeMenu
            Button {
                model.deleteStatus(row)
            } label: {
                Image(systemName: "xmark")
                    .frame(width: Tokens.Size.minimumHitArea, height: Tokens.Size.minimumHitArea)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .foregroundStyle(blocker == nil ? Tokens.Text.secondary.color : Tokens.Text.tertiary.color)
            .disabled(blocker != nil)
            .accessibilityLabel(Copy.deleteStatus)
            .accessibilityHint(blocker ?? "")
            .accessibilityIdentifier("tasks.projectEditor.deleteStatus")
        }
        .deleteDisabled(blocker != nil)
        .accessibilityAction(named: Copy.moveUp) { model.moveStatus(row, by: -1) }
        .accessibilityAction(named: Copy.moveDown) { model.moveStatus(row, by: 1) }
    }

    private var colorMenu: some View {
        Menu {
            ForEach(ProjectPalette.swatches) { swatch in
                Button {
                    row.color = swatch.hex
                } label: {
                    if swatch.hex.caseInsensitiveCompare(row.color) == .orderedSame {
                        Label(Copy.colorName(swatch.id), systemImage: "checkmark")
                    } else {
                        Text(Copy.colorName(swatch.id))
                    }
                }
            }
        } label: {
            Circle()
                .fill(Tokens.Palette.color(row.color))
                .frame(width: Tokens.Space.inset, height: Tokens.Space.inset)
                .frame(width: Tokens.Size.minimumHitArea, height: Tokens.Size.minimumHitArea)
                .contentShape(.rect)
        }
        .accessibilityLabel(Copy.changeStatusColor)
        .accessibilityValue(ProjectPalette.swatch(for: row.color).map { Copy.colorName($0.id) } ?? row.color)
        .accessibilityIdentifier("tasks.projectEditor.statusColor")
    }

    private var typeMenu: some View {
        Menu {
            ForEach(ProjectEditorModel.statusTypes, id: \.self) { type in
                Button {
                    row.statusType = type
                } label: {
                    if type == row.statusType {
                        Label(TasksCopy.statusTypeLabel(type), systemImage: "checkmark")
                    } else {
                        Text(TasksCopy.statusTypeLabel(type))
                    }
                }
            }
        } label: {
            Text(TasksCopy.statusTypeLabel(row.statusType))
                .font(Tokens.Typography.caption.font)
                .foregroundStyle(Tokens.Text.secondary.color)
                .frame(minHeight: Tokens.Size.minimumHitArea)
                .contentShape(.rect)
        }
        .accessibilityLabel(Copy.statusType)
        .accessibilityValue(TasksCopy.statusTypeLabel(row.statusType))
        .accessibilityIdentifier("tasks.projectEditor.statusType")
    }
}
