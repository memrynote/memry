import MemryCore
import SwiftUI

// TP052, redesigned (RD19, Paper "New / edit project sheet"). Desktop's
// `project-modal.tsx` as a compact sheet: the colour dot (or emoji; tap to set
// one) and the name (≤50), the palette in one row, the description, then a
// Statuses row that opens the status editor. Delete (not the Inbox) sits
// under it when editing. xmark closes, behind the unsaved-changes guard (also
// on swipe-down); the checkmark creates or saves.

private typealias Copy = TasksCopy.Projects

/// TP052 — create (`projectId == nil`) or edit a project.
struct ProjectEditorSheet: View {
    let store: TasksStore
    let projectId: String?
    /// Called after the project was deleted from this sheet.
    var onDeleted: (() -> Void)?

    @Environment(\.dismiss) private var dismiss
    @State private var model: ProjectEditorModel
    @State private var confirmDiscard = false
    @State private var deleting: ProjectItem?
    @State private var isSaving = false
    @State private var showsIconField = false
    @State private var iconText = ""
    @FocusState private var nameFocused: Bool

    init(store: TasksStore, projectId: String?, onDeleted: (() -> Void)? = nil) {
        self.store = store
        self.projectId = projectId
        self.onDeleted = onDeleted
        _model = State(initialValue: ProjectEditorModel(project: store.project(projectId)))
    }

    var body: some View {
        NavigationStack {
            List {
                nameRow
                if showsIconField { iconRows }
                if let error = model.nameError, !model.form.name.isEmpty || model.hasChanges {
                    errorText(error)
                }
                ProjectColorPalette(selection: model.form.color) { model.form.color = $0 }
                    .sheetRow()
                TextField(Copy.descriptionPlaceholder, text: $model.form.description, axis: .vertical)
                    .font(Tokens.Typography.body.font)
                    .lineLimit(1 ... 6)
                    .accessibilityLabel(Copy.descriptionOptional)
                    .accessibilityIdentifier("tasks.projectEditor.description")
                    .sheetRow()
                statusesRow
                if let error = model.statusesError { errorText(error) }
                if model.canDeleteProject {
                    Button(Copy.deleteProject, role: .destructive) { deleting = store.project(projectId) }
                        .frame(minHeight: Tokens.Size.minimumHitArea)
                        .accessibilityIdentifier("tasks.projectEditor.delete")
                        .sheetRow()
                }
                if let failure = store.failure {
                    ErrorNotice(error: failure, code: nil).sheetRow()
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .environment(\.defaultMinListRowHeight, 0)
            .navigationTitle(model.isEditing ? Copy.editProject : Copy.newProject)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { toolbar }
            .onChange(of: model.form) { model.clampInputs() }
        }
        .presentationDetents(model.isEditing ? [.large] : [.medium, .large])
        .presentationBackground(Tokens.Canvas.background.color)
        .interactiveDismissDisabled(model.hasChanges)
        .alert(Copy.unsavedChanges, isPresented: $confirmDiscard) {
            Button(Copy.cancel, role: .cancel) {}
            Button(Copy.discard, role: .destructive) { dismiss() }
                .accessibilityIdentifier("tasks.projectEditor.discard")
        } message: {
            Text(Copy.unsavedChangesBody)
        }
        .projectDeleteDialog($deleting, store: store) {
            dismiss()
            onDeleted?()
        }
        .onAppear {
            store.clearFailure()
            if !model.isEditing { nameFocused = true }
        }
    }

    /// The colour dot (or emoji) and the name in the sheet's large type.
    private var nameRow: some View {
        HStack(spacing: Tokens.Space.medium) {
            Button { showsIconField.toggle() } label: {
                ProjectIconView(icon: model.form.icon, color: model.form.color)
                    .frame(width: Tokens.Size.minimumHitArea, height: Tokens.Size.minimumHitArea)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Copy.selectIcon)
            .accessibilityIdentifier("tasks.projectEditor.icon")
            TextField(Copy.projectName, text: $model.form.name)
                .font(Tokens.Typography.sectionTitle.font)
                .foregroundStyle(Tokens.Text.primary.color)
                .textInputAutocapitalization(.sentences)
                .focused($nameFocused)
                .accessibilityIdentifier("tasks.projectEditor.name")
        }
        // The dot's centre lines up with the first swatch's.
        .sheetRow(leading: Tokens.Space.inset)
    }

    @ViewBuilder private var iconRows: some View {
        TextField(Copy.emojiField, text: $iconText)
            .font(Tokens.Typography.body.font)
            .frame(minHeight: Tokens.Size.minimumHitArea)
            .accessibilityHint(Copy.iconHint)
            .accessibilityIdentifier("tasks.projectEditor.emoji")
            .onChange(of: iconText) { _, typed in
                if let emoji = ProjectIconValue.sanitize(typed) { model.form.icon = emoji }
                if !typed.isEmpty { iconText = "" }
            }
            .sheetRow()
        if ProjectIconValue.emoji(model.form.icon) != nil {
            Button(Copy.removeIcon) { model.form.icon = ProjectIconValue.defaultIcon }
                .frame(minHeight: Tokens.Size.minimumHitArea)
                .accessibilityIdentifier("tasks.projectEditor.removeIcon")
                .sheetRow()
        }
    }

    /// "Statuses ◌◐● 3 ›" on a surface panel; opens the status editor.
    private var statusesRow: some View {
        NavigationLink {
            ProjectStatusesPage(model: model)
        } label: {
            HStack(spacing: Tokens.Space.small) {
                Text(Copy.statuses)
                    .font(Tokens.Typography.body.font)
                    .foregroundStyle(Tokens.Text.primary.color)
                Spacer(minLength: Tokens.Space.small)
                HStack(spacing: Tokens.Space.tight) {
                    ForEach(model.form.statuses.prefix(4)) { row in
                        TaskStatusIcon(
                            statusType: row.statusType,
                            isDone: row.statusType == "done",
                            color: Tokens.Palette.color(row.color),
                            scale: .small
                        )
                    }
                }
                .accessibilityHidden(true)
                Text("\(model.form.statuses.count)")
                    .font(Tokens.Typography.body.font.monospacedDigit())
                    .foregroundStyle(Tokens.Text.tertiary.color)
                Image(systemName: "chevron.forward")
                    .font(Tokens.Typography.caption.font.weight(.semibold))
                    .foregroundStyle(Tokens.Text.tertiary.color)
                    .accessibilityHidden(true)
            }
            .padding(.horizontal, Tokens.Space.inset)
            .frame(minHeight: Tokens.Size.minimumHitArea + Tokens.Space.tight)
            .background(Tokens.Canvas.surface.color, in: .rect(cornerRadius: Tokens.Radius.panel))
            .contentShape(.rect)
        }
        .navigationLinkIndicatorVisibility(.hidden)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("tasks.projectEditor.statuses")
        .sheetRow(leading: TaskLayout.edge - Tokens.Space.tight, trailing: TaskLayout.edge - Tokens.Space.tight)
    }

    private func errorText(_ error: String) -> some View {
        Text(error)
            .font(Tokens.Typography.caption.font)
            .foregroundStyle(Tokens.Interaction.destructive.color)
            .accessibilityIdentifier("tasks.projectEditor.error")
            .sheetRow()
    }

    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .cancellationAction) {
            Button(role: .close) {
                if model.hasChanges { confirmDiscard = true } else { dismiss() }
            }
            .accessibilityIdentifier("tasks.projectEditor.cancel")
        }
        ToolbarItem(placement: .confirmationAction) {
            TaskSheetConfirmButton(
                label: model.isEditing ? Copy.save : Copy.create,
                isEnabled: model.isValid && !isSaving && (!model.isEditing || model.hasChanges)
            ) {
                isSaving = true
                Task {
                    let saved = await model.save(in: store)
                    isSaving = false
                    if saved { dismiss() }
                }
            }
            .accessibilityIdentifier("tasks.projectEditor.save")
        }
    }
}

/// The status editor on its own page, reorder in the toolbar.
private struct ProjectStatusesPage: View {
    @Bindable var model: ProjectEditorModel
    @State private var editMode: EditMode = .inactive

    var body: some View {
        Form {
            ProjectStatusEditor(model: model)
        }
        .environment(\.editMode, $editMode)
        .navigationTitle(Copy.statuses)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button(editMode.isEditing ? Copy.doneReordering : Copy.reorderProjects) {
                    editMode = editMode.isEditing ? .inactive : .active
                }
                .accessibilityIdentifier("tasks.projectEditor.reorderStatuses")
            }
        }
    }
}

private extension View {
    /// A plain sheet row: no separator, no fill, Paper's 24pt side margins.
    func sheetRow(leading: CGFloat = TaskLayout.edge, trailing: CGFloat = TaskLayout.edge) -> some View {
        listRowSeparator(.hidden)
            .listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets(top: Tokens.Space.tight, leading: leading, bottom: Tokens.Space.tight, trailing: trailing))
    }
}
