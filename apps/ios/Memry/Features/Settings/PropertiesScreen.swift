import MemryCore
import SwiftUI

// Spec 006 ST64, artboards 28 / 29 / 29a / 29b. Property definitions by type;
// a select, multiselect or status property's options can be added, renamed,
// recoloured, removed and reordered (desktop `properties-section.tsx`).
// Deleting a definition leaves note values as they are (desktop, §6).
struct PropertiesScreen: View {
    let context: SettingsContext
    @State private var definitions: [PropertyDefinitionItem] = []
    @State private var query = ""
    @State private var failure: UserFacingError?

    var body: some View {
        List {
            if let failure { Section { ErrorNotice(error: failure, code: nil) } }
            Section {
                ForEach(filtered, id: \.name) { definition in
                    NavigationLink(value: SettingsRoute.property(definition.name)) {
                        SettingsRowLabel(title: definition.name, detail: PropertiesCopy.summary(definition))
                    }
                    .accessibilityIdentifier("settings.property.\(definition.name)")
                }
            } header: {
                Text(PropertiesCopy.header(definitions.count))
            } footer: {
                SettingsFooter(PropertiesCopy.footer)
            }
        }
        .settingsList()
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: PropertiesCopy.filter)
        .navigationTitle(SettingsCopy.properties)
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .refreshable { await load() }
    }

    private var filtered: [PropertyDefinitionItem] {
        query.isEmpty ? definitions : definitions.filter { $0.name.localizedCaseInsensitiveContains(query) }
    }

    private func load() async {
        switch await context.read({ try $0.propertyDefinitions() }) {
        case let .success(list): definitions = list
        case let .failure(error): failure = error
        }
    }
}

struct PropertyDetailScreen: View {
    let context: SettingsContext
    let name: String
    @State private var definition: PropertyDefinitionItem?
    @State private var failure: UserFacingError?
    @State private var adding = false
    @State private var draft = ""
    @State private var addCategory: String?
    @State private var renaming: PropertyOptionItem?
    @State private var recolouring: PropertyOptionItem?
    @State private var deleting = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        List {
            if let failure { Section { ErrorNotice(error: failure, code: nil) } }
            if let definition {
                Section {
                    LabeledContent(PropertiesCopy.name, value: definition.name)
                    LabeledContent(PropertiesCopy.type, value: PropertiesCopy.typeName(definition.typeName))
                    LabeledContent(PropertiesCopy.usedIn, value: PropertiesCopy.notes(Int(definition.usedIn)))
                }
                if PropertiesCopy.hasOptions(definition.typeName) {
                    Section {
                        ForEach(definition.options, id: \.value) { option in
                            optionRow(option)
                        }
                        .onMove { from, to in Task { await move(from: from, to: to) } }
                        Button(PropertiesCopy.addOption, systemImage: "plus") {
                            draft = ""
                            addCategory = definition.options.first?.category
                            adding = true
                        }
                        .accessibilityIdentifier("settings.property.addOption")
                    } header: {
                        Text(PropertiesCopy.options)
                    } footer: {
                        SettingsFooter(PropertiesCopy.optionsFooter)
                    }
                }
                Section {
                    SettingsDestructiveRow(title: PropertiesCopy.deleteProperty, identifier: "settings.property.delete") {
                        deleting = true
                    }
                }
            }
        }
        .settingsList()
        .navigationTitle(name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { EditButton() }
        .task { await load() }
        .alert(PropertiesCopy.addOption, isPresented: $adding) {
            TextField(PropertiesCopy.optionName, text: $draft)
            Button(SettingsCopy.cancel, role: .cancel) {}
            Button(PropertiesCopy.add) { Task { await add() } }
        }
        .alert(SettingsCopy.rename, isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
            TextField(PropertiesCopy.optionName, text: $draft)
            Button(SettingsCopy.cancel, role: .cancel) {}
            Button(SettingsCopy.rename) { let option = renaming; Task { await rename(option) } }
        }
        .sheet(item: $recolouring) { option in
            OptionColorSheet(option: option) { color in Task { await recolour(option, color) } }
        }
        .confirmationDialog(PropertiesCopy.deleteTitle(name), isPresented: $deleting, titleVisibility: .visible) {
            Button(PropertiesCopy.deleteProperty, role: .destructive) { Task { await deleteDefinition() } }
        } message: {
            Text(PropertiesCopy.deleteMessage(Int(definition?.usedIn ?? 0)))
        }
    }

    private func optionRow(_ option: PropertyOptionItem) -> some View {
        HStack(spacing: Tokens.Space.medium) {
            Circle().fill(Tokens.Palette.color(option.color))
                .frame(width: Tokens.Space.medium, height: Tokens.Space.medium)
                .accessibilityHidden(true)
            SettingsRowLabel(title: option.value, value: option.category.map(PropertiesCopy.category))
        }
        .contentShape(.rect)
        .accessibilityElement(children: .combine)
        .contextMenu {
            Button(SettingsCopy.rename, systemImage: "pencil") { draft = option.value; renaming = option }
            Button(PropertiesCopy.changeColor, systemImage: "paintpalette") { recolouring = option }
            Button(PropertiesCopy.remove, systemImage: "trash", role: .destructive) { Task { await remove(option) } }
        }
        .accessibilityIdentifier("settings.option.\(option.value)")
    }

    private func load() async {
        let name = name
        switch await context.read({ try $0.propertyDefinitions() }) {
        case let .success(list): definition = list.first { $0.name == name }
        case let .failure(error): failure = error
        }
    }

    private func apply(_ result: Result<Void, UserFacingError>) async {
        if case let .failure(error) = result { failure = error } else { failure = nil }
        await load()
    }

    private func add() async {
        let name = name, value = draft
        let color = Tokens.Palette.names[(definition?.options.count ?? 0) % Tokens.Palette.names.count]
        let category = definition?.typeName == "status" ? (addCategory ?? "todo") : nil
        await apply(await context.run { try $0.addPropertyOption(name: name, value: value, color: color, category: category) })
    }

    private func rename(_ option: PropertyOptionItem?) async {
        guard let option else { return }
        renaming = nil
        let name = name, old = option.value, new = draft
        await apply(await context.run { try $0.renamePropertyOption(name: name, oldValue: old, newValue: new) })
    }

    private func recolour(_ option: PropertyOptionItem, _ color: String) async {
        recolouring = nil
        let name = name, value = option.value
        await apply(await context.run { try $0.setPropertyOptionColor(name: name, value: value, color: color) })
    }

    private func remove(_ option: PropertyOptionItem) async {
        let name = name, value = option.value
        await apply(await context.run { try $0.removePropertyOption(name: name, value: value) })
    }

    private func move(from: IndexSet, to: Int) async {
        guard var values = definition?.options.map(\.value) else { return }
        values.move(fromOffsets: from, toOffset: to)
        let name = name, order = values
        await apply(await context.run { try $0.reorderPropertyOptions(name: name, values: order) })
    }

    private func deleteDefinition() async {
        let name = name
        switch await context.run({ try $0.deletePropertyDefinition(name: name) }) {
        case .success: dismiss()
        case let .failure(error): failure = error
        }
    }
}

extension PropertyOptionItem: @retroactive Identifiable {
    public var id: String { value }
}

private struct OptionColorSheet: View {
    let option: PropertyOptionItem
    let save: (String) -> Void

    var body: some View {
        NavigationStack {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: Tokens.Size.minimumHitArea))]) {
                ForEach(Tokens.Palette.names, id: \.self) { name in
                    ColorSwatch(color: Tokens.Palette.color(name), name: name, isSelected: option.color == name) { save(name) }
                }
            }
            .padding(Tokens.Space.inset)
            .navigationTitle(option.value)
            .navigationBarTitleDisplayMode(.inline)
        }
        .presentationDetents([.medium])
    }
}

enum PropertiesCopy {
    static let filter = "Filter properties"
    static func header(_ count: Int) -> String { "\(count) property definitions" }
    static let footer = "Definitions are shared by every note. New properties are added from a note’s property row."
    static let name = "Name"
    static let type = "Type"
    static let usedIn = "Used in"
    static func notes(_ count: Int) -> String { count == 1 ? "1 note" : "\(count) notes" }
    static let options = "Options"
    static let optionsFooter = "Long press an option to rename, recolor or remove it. Edit to reorder."
    static let addOption = "Add option"
    static let optionName = "Option name"
    static let add = "Add"
    static let changeColor = "Change color"
    static let remove = "Remove"
    static let deleteProperty = "Delete property"
    static func deleteTitle(_ name: String) -> String { "Delete property “\(name)”?" }
    static func deleteMessage(_ count: Int) -> String {
        "Its definition is removed from every device. The \(count == 1 ? "note keeps its value" : "\(count) notes keep their values")."
    }

    static func hasOptions(_ type: String) -> Bool { ["select", "multiselect", "status"].contains(type) }

    static func typeName(_ type: String) -> String {
        switch type {
        case "multiselect": "Multiselect"
        case "url": "URL"
        default: type.prefix(1).uppercased() + type.dropFirst()
        }
    }

    static func category(_ key: String) -> String {
        switch key {
        case "todo": "To do"
        case "in_progress": "In progress"
        case "done": "Done"
        default: key
        }
    }

    static func summary(_ definition: PropertyDefinitionItem) -> String {
        let type = typeName(definition.typeName)
        guard hasOptions(definition.typeName) else { return type }
        return "\(type) · \(definition.options.count) options"
    }
}
