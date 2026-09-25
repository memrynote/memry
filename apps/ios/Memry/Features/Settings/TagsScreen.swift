import MemryCore
import SwiftUI

// Spec 006 ST62 / ST63, artboards 25–27d. Every tag across notes, journals
// and tasks with its colour and count. Long press: Rename, Change color and
// icon, Merge into…, Delete; each rewrites every item carrying the tag
// (core `tag_admin`) and syncs.
struct TagsScreen: View {
    let context: SettingsContext
    @State private var tags: [TagItem] = []
    @State private var query = ""
    @State private var failure: UserFacingError?
    @State private var notice: String?
    @State private var renaming: TagItem?
    @State private var draft = ""
    @State private var deleting: TagItem?
    @State private var merging: TagItem?
    @State private var styling: TagItem?

    var body: some View {
        List {
            if let failure { Section { ErrorNotice(error: failure, code: nil) } }
            Section {
                ForEach(filtered, id: \.name) { tag in
                    NavigationLink(value: TagRoute(name: tag.name)) { TagRow(tag: tag) }
                        .contextMenu { menu(tag) }
                        .accessibilityIdentifier("settings.tag.\(tag.name)")
                        .accessibilityActions { menu(tag) }
                }
            } header: {
                Text(TagsCopy.header(tags.count))
            } footer: {
                SettingsFooter(TagsCopy.footer)
            }
        }
        .settingsList()
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: TagsCopy.filter)
        .navigationTitle(SettingsCopy.tags)
        .navigationBarTitleDisplayMode(.inline)
        .overlay(alignment: .bottom) { SettingsToast(text: $notice) }
        .task { await load() }
        .refreshable { await load() }
        .alert(TagsCopy.renameTitle(renaming?.name ?? ""), isPresented: present($renaming)) {
            TextField(TagsCopy.newName, text: $draft)
                .textInputAutocapitalization(.never)
                .accessibilityIdentifier("settings.tags.renameField")
            Button(SettingsCopy.cancel, role: .cancel) {}
            Button(SettingsCopy.rename) { let tag = renaming; Task { await rename(tag) } }
        } message: {
            Text(TagsCopy.renameMessage(renaming.map(count) ?? 0))
        }
        .confirmationDialog(TagsCopy.deleteTitle(deleting?.name ?? ""), isPresented: present($deleting), titleVisibility: .visible) {
            Button(TagsCopy.deleteAction, role: .destructive) { let tag = deleting; Task { await delete(tag) } }
        } message: {
            Text(TagsCopy.deleteMessage(deleting.map(count) ?? 0))
        }
        .sheet(item: $merging) { source in
            TagMergeSheet(source: source, count: count(source), tags: tags.filter { $0.name != source.name }) { target in
                Task { await merge(source, into: target) }
            }
        }
        .sheet(item: $styling) { tag in
            TagStyleSheet(tag: tag) { color, icon in Task { await style(tag, color: color, icon: icon) } }
        }
    }

    private var filtered: [TagItem] {
        query.isEmpty ? tags : tags.filter { $0.name.localizedCaseInsensitiveContains(query) }
    }

    private func count(_ tag: TagItem) -> Int { Int(tag.notes + tag.journals + tag.tasks) }

    @ViewBuilder
    private func menu(_ tag: TagItem) -> some View {
        Button(SettingsCopy.rename, systemImage: "pencil") { draft = tag.name; renaming = tag }
        Button(TagsCopy.style, systemImage: "paintpalette") { styling = tag }
        Button(TagsCopy.merge, systemImage: "arrow.triangle.merge") { merging = tag }
        Button(TagsCopy.delete, systemImage: "trash", role: .destructive) { deleting = tag }
    }

    private func present(_ item: Binding<TagItem?>) -> Binding<Bool> {
        Binding(get: { item.wrappedValue != nil }, set: { if !$0 { item.wrappedValue = nil } })
    }

    private func load() async {
        switch await context.read({ try $0.tagList() }) {
        case let .success(list): tags = list
        case let .failure(error): failure = error
        }
    }

    private func rename(_ tag: TagItem?) async {
        guard let tag else { return }
        let old = tag.name, new = draft.trimmingCharacters(in: .whitespaces)
        renaming = nil
        guard !new.isEmpty, new != old else { return }
        await finish(await context.run { try $0.renameTag(oldName: old, newName: new) }) { TagsCopy.renamed(old, new, $0) }
    }

    private func delete(_ tag: TagItem?) async {
        guard let tag else { return }
        deleting = nil
        let name = tag.name
        await finish(await context.run { try $0.deleteTag(tag: name) }) { TagsCopy.deleted(name, $0) }
    }

    private func merge(_ source: TagItem, into target: String) async {
        merging = nil
        let from = source.name
        await finish(await context.run { try $0.mergeTag(source: from, target: target) }) { TagsCopy.merged(from, target, $0) }
    }

    private func style(_ tag: TagItem, color: String?, icon: String?) async {
        styling = nil
        let name = tag.name
        if let color, color != tag.color {
            if case let .failure(error) = await context.run({ try $0.setTagColor(tag: name, color: color) }) { failure = error }
        }
        if icon != tag.icon {
            if case let .failure(error) = await context.run({ try $0.setTagIcon(tag: name, icon: icon) }) { failure = error }
        }
        await load()
    }

    private func finish(_ result: Result<UInt32, UserFacingError>, _ message: (Int) -> String) async {
        switch result {
        case let .success(count):
            failure = nil
            notice = message(Int(count))
        case let .failure(error): failure = error
        }
        await load()
    }
}

extension TagItem: @retroactive Identifiable {
    public var id: String { name }
}

private struct TagRow: View {
    let tag: TagItem

    var body: some View {
        HStack(spacing: Tokens.Space.medium) {
            Circle()
                .fill(Tokens.Palette.color(tag.color, tag: tag.name))
                .frame(width: Tokens.Space.medium, height: Tokens.Space.medium)
                .accessibilityHidden(true)
            if let icon = tag.icon, !icon.hasPrefix("icon:") { Text(icon).accessibilityHidden(true) }
            SettingsRowLabel(title: "#\(tag.name)", value: "\(tag.notes + tag.journals + tag.tasks)")
        }
    }
}

/// Artboard 27: pick the tag to merge into, with a filter.
private struct TagMergeSheet: View {
    let source: TagItem
    let count: Int
    let tags: [TagItem]
    let merge: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var confirming: String?

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(tags.filter { query.isEmpty || $0.name.localizedCaseInsensitiveContains(query) }, id: \.name) { tag in
                        Button { confirming = tag.name } label: { TagRow(tag: tag) }
                            .accessibilityIdentifier("settings.merge.\(tag.name)")
                    }
                } header: {
                    Text(TagsCopy.mergeInto)
                } footer: {
                    SettingsFooter(TagsCopy.mergeMessage(source.name, count))
                }
            }
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always))
            .navigationTitle(TagsCopy.mergeTitle(source.name))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(SettingsCopy.cancel, systemImage: "xmark") { dismiss() } }
            }
            .confirmationDialog(TagsCopy.confirmMerge(source.name, confirming ?? ""),
                                isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } }),
                                titleVisibility: .visible) {
                Button(TagsCopy.merge, role: .destructive) { if let target = confirming { merge(target) } }
            }
        }
        .presentationDetents([.medium, .large])
    }
}

/// Artboard 27b: colour and icon.
private struct TagStyleSheet: View {
    let tag: TagItem
    let save: (String?, String?) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var color: String?
    @State private var icon = ""

    var body: some View {
        NavigationStack {
            Form {
                Section(TagsCopy.color) {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: Tokens.Size.minimumHitArea))]) {
                        ForEach(Tokens.Palette.names, id: \.self) { name in
                            ColorSwatch(color: Tokens.Palette.color(name), name: name, isSelected: color == name) { color = name }
                        }
                    }
                }
                Section {
                    TextField(TagsCopy.iconPlaceholder, text: $icon)
                    Button(TagsCopy.noIcon) { icon = "" }
                } header: {
                    Text(TagsCopy.icon)
                } footer: {
                    SettingsFooter(TagsCopy.iconFooter)
                }
            }
            .navigationTitle("#\(tag.name)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(SettingsCopy.cancel, systemImage: "xmark") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(SettingsCopy.done, systemImage: "checkmark") {
                        save(color, icon.isEmpty ? nil : String(icon.prefix(8)))
                    }
                    .buttonStyle(.glassProminent)
                }
            }
            .onAppear {
                color = tag.color
                icon = tag.icon ?? ""
            }
        }
        .presentationDetents([.medium, .large])
    }
}

enum TagsCopy {
    static let filter = "Filter tags"
    static func header(_ count: Int) -> String { "\(count) tags across notes, journals and tasks" }
    static let footer = "Long press a tag for Rename, Color, Icon, Merge and Delete. Tap to see everything with it."
    static func renameTitle(_ name: String) -> String { "Rename #\(name)" }
    static func renameMessage(_ count: Int) -> String { "Updates it in all \(count) items." }
    static let newName = "New name"
    static func renamed(_ old: String, _ new: String, _ count: Int) -> String { "Renamed “\(old)” to “\(new)” (\(count) items)" }
    static let style = "Change color and icon"
    static let merge = "Merge into…"
    static let delete = "Delete"
    static func deleteTitle(_ name: String) -> String { "Delete #\(name)?" }
    static func deleteMessage(_ count: Int) -> String { "It is removed from \(count) items. The items stay." }
    static let deleteAction = "Delete tag"
    static func deleted(_ name: String, _ count: Int) -> String { "Deleted “\(name)” (\(count) items)" }
    static func mergeTitle(_ name: String) -> String { "Merge #\(name)" }
    static let mergeInto = "Merge into"
    static func mergeMessage(_ name: String, _ count: Int) -> String { "Its \(count) items get the tag you pick. #\(name) is removed." }
    static func confirmMerge(_ source: String, _ target: String) -> String { "Merge #\(source) into #\(target)?" }
    static func merged(_ source: String, _ target: String, _ count: Int) -> String { "Merged “\(source)” into “\(target)” (\(count) items)" }
    static let color = "Color"
    static let icon = "Icon"
    static let iconPlaceholder = "An emoji"
    static let noIcon = "None"
    static let iconFooter = "Shows beside the tag in notes, tasks and the tag list. Shared with your other devices."
}
