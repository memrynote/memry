import MemryCore
import SwiftUI

// Spec 006 ST60 / ST61, artboards 19 / 19a / 20 / 20a. Built-in templates
// (read-only, duplicate only) and the vault's own (edit, duplicate, delete).
// The editor edits title, icon, tags and the body; notes made from a template
// are never changed by editing or deleting it.
struct TemplatesScreen: View {
    let context: SettingsContext
    @State private var templates: [TemplateItem] = []
    @State private var failure: UserFacingError?
    @State private var deleting: TemplateItem?
    @State private var duplicating: TemplateItem?
    @State private var draftName = ""
    @State private var creating = false
    @State private var notice: String?
    @Environment(TasksRouter.self) private var router

    var body: some View {
        List {
            if let failure { Section { ErrorNotice(error: failure, code: nil) } }
            Section(TemplatesCopy.builtIn) {
                ForEach(templates.filter(\.isBuiltIn), id: \.id) { row($0) }
            }
            Section {
                ForEach(templates.filter { !$0.isBuiltIn }, id: \.id) { template in
                    NavigationLink(value: SettingsRoute.template(template.id)) { label(template) }
                        .contextMenu { menu(template) }
                        .swipeActions { Button(TemplatesCopy.delete, role: .destructive) { deleting = template } }
                }
            } header: {
                Text(TemplatesCopy.mine)
            } footer: {
                SettingsFooter(TemplatesCopy.footer)
            }
        }
        .settingsList()
        .navigationTitle(SettingsCopy.templates)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button(TemplatesCopy.new, systemImage: "plus") {
                    draftName = ""
                    creating = true
                }
                .accessibilityIdentifier("settings.templates.new")
            }
        }
        .overlay(alignment: .bottom) { SettingsToast(text: $notice) }
        .task { await load() }
        .alert(TemplatesCopy.new, isPresented: $creating) {
            TextField(TemplatesCopy.namePlaceholder, text: $draftName)
            Button(SettingsCopy.cancel, role: .cancel) {}
            Button(TemplatesCopy.create) { Task { await create() } }
        }
        .alert(TemplatesCopy.duplicateTitle, isPresented: Binding(get: { duplicating != nil }, set: { if !$0 { duplicating = nil } })) {
            TextField(TemplatesCopy.namePlaceholder, text: $draftName)
            Button(SettingsCopy.cancel, role: .cancel) {}
            Button(TemplatesCopy.duplicate) { let source = duplicating; Task { await duplicate(source) } }
        } message: {
            Text(TemplatesCopy.duplicateMessage)
        }
        .confirmationDialog(TemplatesCopy.deleteTitle(deleting?.name ?? ""),
                            isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
                            titleVisibility: .visible) {
            Button(TemplatesCopy.deleteAction, role: .destructive) { let template = deleting; Task { await delete(template) } }
        } message: {
            Text(TemplatesCopy.deleteMessage)
        }
    }

    private func row(_ template: TemplateItem) -> some View {
        label(template).contextMenu { menu(template) }
    }

    private func label(_ template: TemplateItem) -> some View {
        SettingsRowLabel(
            title: [template.icon, template.name].compactMap(\.self).joined(separator: " "),
            detail: template.isBuiltIn ? TemplatesCopy.builtIn : template.modifiedAt.flatMap(TemplatesCopy.edited)
        )
        .accessibilityIdentifier("settings.template.\(template.name)")
    }

    @ViewBuilder
    private func menu(_ template: TemplateItem) -> some View {
        if !template.isBuiltIn {
            Button(TemplatesCopy.edit, systemImage: "pencil") {
                router.settingsPath.append(SettingsRoute.template(template.id))
            }
        }
        Button(TemplatesCopy.duplicate, systemImage: "plus.square.on.square") {
            draftName = TemplatesCopy.copyName(template.name)
            duplicating = template
        }
        if !template.isBuiltIn {
            Button(TemplatesCopy.delete, systemImage: "trash", role: .destructive) { deleting = template }
        }
    }

    private func load() async {
        switch await context.read({ try $0.templateList() }) {
        case let .success(list): templates = list
        case let .failure(error): failure = error
        }
    }

    private func create() async {
        let name = draftName
        if case let .success(id) = await context.run({ try $0.createTemplate(name: name) }) {
            await load()
            router.settingsPath.append(SettingsRoute.template(id))
        }
    }

    private func duplicate(_ source: TemplateItem?) async {
        guard let source else { return }
        let name = draftName
        duplicating = nil
        switch await context.run({ try $0.duplicateTemplate(id: source.id, name: name) }) {
        case .success: notice = TemplatesCopy.duplicated
        case let .failure(error): failure = error
        }
        await load()
    }

    private func delete(_ template: TemplateItem?) async {
        guard let template else { return }
        deleting = nil
        switch await context.run({ try $0.deleteTemplate(id: template.id) }) {
        case .success: notice = TemplatesCopy.deleted
        case let .failure(error): failure = error
        }
        await load()
    }
}

/// Artboard 20: title, icon, tags and body. Saves on Done and on leaving.
struct TemplateEditorScreen: View {
    let context: SettingsContext
    let templateId: String
    @State private var draft: TemplateDraft?
    @State private var saved: TemplateDraft?
    @State private var tagsText = ""
    @State private var failure: UserFacingError?

    var body: some View {
        Form {
            if let failure { Section { ErrorNotice(error: failure, code: nil) } }
            if draft != nil {
                Section {
                    TextField(TemplatesCopy.namePlaceholder, text: field(\.name))
                        .font(Tokens.Typography.heading.font)
                        .accessibilityIdentifier("settings.template.name")
                    TextField(TemplatesCopy.icon, text: iconField)
                    TextField(TemplatesCopy.tags, text: $tagsText)
                        .textInputAutocapitalization(.never)
                        .accessibilityIdentifier("settings.template.tags")
                }
                Section {
                    TextEditor(text: field(\.content))
                        .font(TypeRole(.body, design: .monospaced).font)
                        .frame(minHeight: 240)
                        .accessibilityIdentifier("settings.template.body")
                } footer: {
                    SettingsFooter(TemplatesCopy.editorFooter)
                }
            } else {
                ProgressView()
            }
        }
        .navigationTitle(draft?.name ?? SettingsCopy.templates)
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .onDisappear { Task { await save() } }
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button(SettingsCopy.done) { Task { await save() } }
            }
        }
    }

    private func field(_ key: WritableKeyPath<TemplateDraft, String>) -> Binding<String> {
        Binding(get: { draft?[keyPath: key] ?? "" }, set: { draft?[keyPath: key] = $0 })
    }

    private var iconField: Binding<String> {
        Binding(get: { draft?.icon ?? "" }, set: { draft?.icon = $0.isEmpty ? nil : String($0.prefix(8)) })
    }

    private func load() async {
        guard case let .success(list) = await context.read({ try $0.templateList() }),
              let item = list.first(where: { $0.id == templateId }) else { return }
        let loaded = TemplateDraft(name: item.name, description: item.description, icon: item.icon, tags: item.tags, content: item.content)
        draft = loaded
        saved = loaded
        tagsText = item.tags.joined(separator: ", ")
    }

    private func save() async {
        guard var draft else { return }
        draft.tags = tagsText.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        guard draft != saved else { return }
        let id = templateId
        let value = draft
        switch await context.run({ try $0.updateTemplate(id: id, draft: value) }) {
        case .success: saved = value
        case let .failure(error): failure = error
        }
    }
}

/// Desktop `settings.json` `templates.*` wording.
enum TemplatesCopy {
    static let builtIn = "Built-in"
    static let mine = "My Templates"
    static let new = "New Template"
    static let create = "Create"
    static let edit = "Edit"
    static let duplicate = "Duplicate"
    static let delete = "Delete"
    static let namePlaceholder = "Template name"
    static let icon = "Icon"
    static let tags = "Tags, separated by commas"
    static let footer = "Long press for Edit, Duplicate, Delete. Built-in templates can be duplicated, not edited."
    static let editorFooter = "Title, icon and tags become the defaults for notes made from this template. Shared with your other devices."
    static func edited(_ iso: String) -> String? {
        guard let date = ISO8601DateFormatter.memryFractional.date(from: iso) ?? ISO8601DateFormatter().date(from: iso) else { return nil }
        return "Edited \(SettingsLabels.relative(date))"
    }
    static func copyName(_ name: String) -> String { "\(name) (Copy)" }
    static let duplicateTitle = "Duplicate Template"
    static let duplicateMessage = "Enter a name for the new template copy."
    static let duplicated = "Template duplicated"
    static func deleteTitle(_ name: String) -> String { "Delete “\(name)”?" }
    static let deleteMessage = "Notes already made from it are not changed."
    static let deleteAction = "Delete template"
    static let deleted = "Template deleted"
}

extension ISO8601DateFormatter {
    static var memryFractional: ISO8601DateFormatter {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }
}
