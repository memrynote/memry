import MemryCore
import SwiftUI

// TP052. Desktop's `project-modal.tsx` as a sheet: icon and name (≤50), the
// colour palette, a description, the status editor, Delete (not the Inbox),
// and the unsaved-changes guard on Cancel and on swipe-down.

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

    init(store: TasksStore, projectId: String?, onDeleted: (() -> Void)? = nil) {
        self.store = store
        self.projectId = projectId
        self.onDeleted = onDeleted
        _model = State(initialValue: ProjectEditorModel(project: store.project(projectId)))
    }

    var body: some View {
        NavigationStack {
            Form {
                identitySection
                Section(Copy.color) {
                    ProjectColorPalette(selection: model.form.color) { model.form.color = $0 }
                }
                Section(Copy.descriptionOptional) {
                    TextField(Copy.descriptionPlaceholder, text: $model.form.description, axis: .vertical)
                        .lineLimit(2 ... 6)
                        .accessibilityLabel(Copy.descriptionOptional)
                        .accessibilityIdentifier("tasks.projectEditor.description")
                }
                ProjectStatusEditor(model: model)
                if model.canDeleteProject {
                    Section {
                        Button(Copy.deleteProject, role: .destructive) {
                            deleting = store.project(projectId)
                        }
                        .frame(minHeight: Tokens.Size.minimumHitArea)
                        .accessibilityIdentifier("tasks.projectEditor.delete")
                    }
                }
                if let failure = store.failure {
                    Section { ErrorNotice(error: failure, code: nil) }
                }
            }
            .navigationTitle(model.isEditing ? Copy.editProjectTitle : Copy.createProject)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { toolbar }
            .onChange(of: model.form) { model.clampInputs() }
        }
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
        .onAppear { store.clearFailure() }
    }

    private var identitySection: some View {
        Section {
            HStack(spacing: Tokens.Space.medium) {
                Button { showsIconField.toggle() } label: {
                    ProjectIconView(icon: model.form.icon, color: model.form.color)
                        .frame(width: Tokens.Size.minimumHitArea, height: Tokens.Size.minimumHitArea)
                        .overlay {
                            RoundedRectangle(cornerRadius: Tokens.Radius.small)
                                .strokeBorder(Tokens.Line.border.color, style: StrokeStyle(dash: [Tokens.Space.tight]))
                        }
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Copy.selectIcon)
                .accessibilityIdentifier("tasks.projectEditor.icon")
                TextField(Copy.projectName, text: $model.form.name)
                    .font(Tokens.Typography.body.font)
                    .textInputAutocapitalization(.sentences)
                    .accessibilityIdentifier("tasks.projectEditor.name")
            }
            if showsIconField {
                TextField(Copy.emojiField, text: $iconText)
                    .accessibilityHint(Copy.iconHint)
                    .accessibilityIdentifier("tasks.projectEditor.emoji")
                    .onChange(of: iconText) { _, typed in
                        if let emoji = ProjectIconValue.sanitize(typed) { model.form.icon = emoji }
                        if !typed.isEmpty { iconText = "" }
                    }
                if ProjectIconValue.emoji(model.form.icon) != nil {
                    Button(Copy.removeIcon) { model.form.icon = ProjectIconValue.defaultIcon }
                        .accessibilityIdentifier("tasks.projectEditor.removeIcon")
                }
            }
        } header: {
            Text(Copy.iconName)
        } footer: {
            if let error = model.nameError, !model.form.name.isEmpty || model.hasChanges {
                Text(error).foregroundStyle(Tokens.Interaction.destructive.color)
            } else if showsIconField {
                Text(Copy.iconHint)
            }
        }
    }

    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .cancellationAction) {
            Button(Copy.cancel) {
                if model.hasChanges { confirmDiscard = true } else { dismiss() }
            }
            .accessibilityIdentifier("tasks.projectEditor.cancel")
        }
        ToolbarItem(placement: .confirmationAction) {
            Button(model.isEditing ? Copy.save : Copy.create) {
                isSaving = true
                Task {
                    let saved = await model.save(in: store)
                    isSaving = false
                    if saved { dismiss() }
                }
            }
            .disabled(!model.isValid || isSaving || (model.isEditing && !model.hasChanges))
            .accessibilityIdentifier("tasks.projectEditor.save")
        }
    }
}
