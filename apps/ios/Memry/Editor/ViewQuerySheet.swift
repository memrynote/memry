//
//  ViewQuerySheet.swift
//  The View row of the insert surfaces: a sheet that picks what a
//  `memry-view` block lists, and the fence it writes for those picks.
//
//  Desktop references: `packages/shared/src/view-block.ts`
//  (`serializeViewBlockDefinition`, `updateViewBlockDefinition`),
//  `view-block.tsx` (`STARTER_VIEW_DEFINITION`, what `/view` inserts) and
//  `view-block-parts.tsx` (`SourcePicker`). The sheet offers only what
//  `ViewBlockFence` draws as rows, so a view made here never shows as code.
//

import MemryCore
import SwiftUI

/// The definition keys this build answers, as the sheet edits them.
struct ViewQueryDraft: Equatable {
    enum SourceKind: String, CaseIterable, Identifiable {
        case vault, folder, tag
        var id: String { rawValue }
    }

    enum Layout: String, CaseIterable, Identifiable {
        case list, table, grid
        var id: String { rawValue }
    }

    var sourceKind: SourceKind = .vault
    var folder = ""
    var tag = ""
    var andTags: [String] = []
    /// `nil` when the fence names none, which stays out of the rewrite.
    var layout: Layout? = .list
    /// The first sort key; `nil` for the source's own order.
    var sort: ViewBlockQuery.SortKey? = .modified
    var descending = true
    /// Order entries after the first. The sheet shows none of them and keeps
    /// them while a first key is set.
    var laterOrder: [ViewBlockQuery.Order] = []
    var limit: Int? = 10
    /// The edited fence's top-level keys in its order: a rewrite keeps them
    /// where they were and appends new ones, as `updateViewBlockDefinition`
    /// spreads the patch over the raw object.
    private(set) var keys: [String] = []

    /// `STARTER_VIEW_DEFINITION`: the ten notes touched most recently.
    static let starter = ViewQueryDraft()

    init() {}

    /// `nil` for a fence this build draws as code, which the sheet cannot
    /// represent without dropping keys.
    init?(fence text: String) {
        guard case let .rows(query) = ViewBlockFence(text: text),
              let data = text.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }
        switch query.source {
        case .vault:
            sourceKind = .vault
        case let .folder(path):
            sourceKind = .folder
            folder = path
        case let .tag(name, andTags):
            sourceKind = .tag
            tag = name
            self.andTags = andTags
        }
        layout = (json["layout"] as? String).flatMap(Layout.init(rawValue:))
        sort = query.order.first?.key
        descending = query.order.first?.descending ?? false
        laterOrder = Array(query.order.dropFirst())
        limit = query.limit
        keys = JSONKeyOrder.topLevel(text)
    }

    /// `nil` until a folder or tag source names one.
    var source: ViewBlockQuery.Source? {
        switch sourceKind {
        case .vault:
            return .vault
        case .folder:
            return folder.isEmpty ? nil : .folder(folder)
        case .tag:
            let name = tag.trimmingCharacters(in: .whitespacesAndNewlines)
            return name.isEmpty ? nil : .tag(tag, andTags: andTags.filter { $0 != tag })
        }
    }

    /// The fence's text, byte for byte what desktop writes for the same
    /// definition. `nil` while ``source`` is.
    var fenceText: String? {
        guard let source else { return nil }
        var fields: [String: JSONText] = ["source": Self.json(source)]
        if let layout { fields["layout"] = .string(layout.rawValue) }
        if let sort {
            let order = [ViewBlockQuery.Order(key: sort, descending: descending)] + laterOrder
            fields["order"] = .array(order.map { entry in
                .object([
                    ("property", .string(entry.key.rawValue)),
                    ("direction", .string(entry.descending ? "desc" : "asc")),
                ])
            })
        }
        if let limit { fields["limit"] = .integer(limit) }
        let kept = keys.filter { $0 != "source" && fields[$0] != nil }
        let added = ["layout", "order", "limit"].filter { !keys.contains($0) && fields[$0] != nil }
        let ordered = (["source"] + kept + added).compactMap { key in fields[key].map { (key, $0) } }
        return JSONText.object(ordered).stringified(depth: 0)
    }

    private static func json(_ source: ViewBlockQuery.Source) -> JSONText {
        switch source {
        case .vault:
            return .object([("kind", .string("vault"))])
        case let .folder(path):
            return .object([("kind", .string("folder")), ("path", .string(path))])
        case let .tag(tag, andTags):
            var fields: [(String, JSONText)] = [("kind", .string("tag")), ("tag", .string(tag))]
            if !andTags.isEmpty { fields.append(("andTags", .array(andTags.map(JSONText.string)))) }
            return .object(fields)
        }
    }
}

/// `JSON.stringify(value, null, 2)` for the shapes a view definition holds.
enum JSONText {
    case string(String)
    case integer(Int)
    case array([JSONText])
    case object([(String, JSONText)])

    func stringified(depth: Int) -> String {
        let inner = String(repeating: "  ", count: depth + 1)
        let outer = String(repeating: "  ", count: depth)
        switch self {
        case let .string(text):
            return Self.quoted(text)
        case let .integer(number):
            return String(number)
        case let .array(items):
            guard !items.isEmpty else { return "[]" }
            let lines = items.map { inner + $0.stringified(depth: depth + 1) }
            return "[\n" + lines.joined(separator: ",\n") + "\n" + outer + "]"
        case let .object(fields):
            guard !fields.isEmpty else { return "{}" }
            let lines = fields.map { inner + Self.quoted($0.0) + ": " + $0.1.stringified(depth: depth + 1) }
            return "{\n" + lines.joined(separator: ",\n") + "\n" + outer + "}"
        }
    }

    /// ECMAScript `QuoteJSONString`: `"`, `\` and control characters
    /// escaped, everything else, `/` and non-ASCII included, as is.
    private static func quoted(_ text: String) -> String {
        var out = "\""
        for scalar in text.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\u{08}": out += "\\b"
            case "\u{0C}": out += "\\f"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            case _ where scalar.value < 0x20:
                out += "\\u" + String(format: "%04x", scalar.value)
            default:
                out.unicodeScalars.append(scalar)
            }
        }
        return out + "\""
    }
}

/// The top-level keys of a JSON object's text, in order. Foundation's parser
/// hands back an unordered dictionary.
enum JSONKeyOrder {
    static func topLevel(_ text: String) -> [String] {
        var keys: [String] = []
        var depth = 0
        var inString = false
        var escaped = false
        var current = ""
        var expectingKey = false
        for character in text {
            if inString {
                if escaped {
                    escaped = false
                    current.append(character)
                } else if character == "\\" {
                    escaped = true
                } else if character == "\"" {
                    inString = false
                    if depth == 1, expectingKey { keys.append(current) }
                    expectingKey = false
                } else {
                    current.append(character)
                }
                continue
            }
            switch character {
            case "\"":
                inString = true
                current = ""
            case "{", "[":
                depth += 1
                expectingKey = character == "{" && depth == 1
            case "}", "]":
                depth -= 1
            case ",":
                expectingKey = depth == 1
            default:
                break
            }
        }
        return keys
    }
}

/// The sheet open on a view block: a new one after `after`, or the block
/// `blockId` whose fence was `text`.
struct ViewQueryRequest: Identifiable, Equatable {
    let blockId: String?
    let after: String?
    let text: String
    var id: String { blockId ?? "new" }
}

struct ViewQuerySheet: View {
    let request: ViewQueryRequest
    let save: (String) -> Void

    @Environment(\.dismiss) private var dismiss
    @Environment(\.vaultBrowse) private var browse
    @State private var draft: ViewQueryDraft
    @State private var folders: [String] = []
    @State private var tags: [String] = []

    init(request: ViewQueryRequest, save: @escaping (String) -> Void) {
        self.request = request
        self.save = save
        _draft = State(initialValue: ViewQueryDraft(fence: request.text) ?? .starter)
    }

    var body: some View {
        NavigationStack {
            Form {
                sourceSection
                Section("Layout") {
                    Picker("Layout", selection: layout) {
                        ForEach(ViewQueryDraft.Layout.allCases) { Text(Self.title($0)).tag($0) }
                    }
                    .pickerStyle(.inline)
                    .labelsHidden()
                }
                sortSection
                Section("Rows") {
                    Toggle("Limit the rows", isOn: limited)
                    if let limit = draft.limit {
                        Stepper("Show \(limit)", value: limitValue, in: 1...1000)
                    }
                }
            }
            .navigationTitle(request.blockId == nil ? "New view" : "Edit view")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") {
                        guard let text = draft.fenceText else { return }
                        save(text)
                    }
                    .disabled(draft.fenceText == nil)
                }
            }
            .task { await loadChoices() }
        }
    }

    private var sourceSection: some View {
        Section("What this view shows") {
            Picker("Source", selection: $draft.sourceKind) {
                Text("All notes").tag(ViewQueryDraft.SourceKind.vault)
                Text("Folder").tag(ViewQueryDraft.SourceKind.folder)
                Text("Tag").tag(ViewQueryDraft.SourceKind.tag)
            }
            .pickerStyle(.inline)
            .labelsHidden()
            switch draft.sourceKind {
            case .vault:
                EmptyView()
            case .folder:
                if folders.isEmpty {
                    Text("No folders yet").foregroundStyle(Tokens.Text.secondary.color)
                } else {
                    Picker("Folder", selection: $draft.folder) {
                        Text("Choose a folder").tag("")
                        ForEach(folders, id: \.self) { Text($0).tag($0) }
                    }
                    .pickerStyle(.navigationLink)
                }
            case .tag:
                if tags.isEmpty {
                    Text("No tags yet").foregroundStyle(Tokens.Text.secondary.color)
                } else {
                    Picker("Tag", selection: $draft.tag) {
                        Text("Choose a tag").tag("")
                        ForEach(tags, id: \.self) { Text("#\($0)").tag($0) }
                    }
                    .pickerStyle(.navigationLink)
                    NavigationLink {
                        AlsoTaggedList(tags: tags.filter { $0 != draft.tag }, selected: $draft.andTags)
                    } label: {
                        LabeledContent("Also tagged", value: draft.andTags.map { "#\($0)" }.joined(separator: " "))
                    }
                    .disabled(draft.tag.isEmpty)
                }
            }
        }
    }

    @ViewBuilder
    private var sortSection: some View {
        Section("Sort") {
            Picker("Sort by", selection: $draft.sort) {
                Text("None").tag(ViewBlockQuery.SortKey?.none)
                Text("Title").tag(ViewBlockQuery.SortKey?.some(.title))
                Text("Created").tag(ViewBlockQuery.SortKey?.some(.created))
                Text("Modified").tag(ViewBlockQuery.SortKey?.some(.modified))
            }
            .pickerStyle(.inline)
            .labelsHidden()
        }
        if draft.sort != nil {
            Section("Sort direction") {
                Picker("Sort direction", selection: $draft.descending) {
                    Text("Ascending").tag(false)
                    Text("Descending").tag(true)
                }
                .pickerStyle(.inline)
                .labelsHidden()
            }
        }
    }

    private var layout: Binding<ViewQueryDraft.Layout> {
        Binding(get: { draft.layout ?? .list }, set: { draft.layout = $0 })
    }

    private var limited: Binding<Bool> {
        Binding(get: { draft.limit != nil }, set: { draft.limit = $0 ? 10 : nil })
    }

    private var limitValue: Binding<Int> {
        Binding(get: { draft.limit ?? 10 }, set: { draft.limit = $0 })
    }

    private static func title(_ layout: ViewQueryDraft.Layout) -> String {
        switch layout {
        case .list: "List"
        case .table: "Table"
        case .grid: "Grid"
        }
    }

    /// Desktop's source menu lists the vault's folders and tags. This device
    /// knows a folder as a configured one or a note's path, as its own
    /// folder list does.
    private func loadChoices() async {
        guard let reader = browse?.reader else { return }
        let notes = (try? await reader.list()) ?? []
        let configured = (try? await reader.folders()) ?? []
        folders = Set(configured.map(\.path) + notes.compactMap(\.folderPath))
            .filter { !$0.isEmpty }
            .sorted { $0.localizedStandardCompare($1) == .orderedAscending }
        tags = ((try? await reader.tags()) ?? []).map(\.name)
            .sorted { $0.localizedStandardCompare($1) == .orderedAscending }
    }
}

/// The tags a tag source also requires, each one a checkmark.
private struct AlsoTaggedList: View {
    let tags: [String]
    @Binding var selected: [String]

    var body: some View {
        List(tags, id: \.self) { tag in
            Button {
                if let index = selected.firstIndex(of: tag) {
                    selected.remove(at: index)
                } else {
                    selected.append(tag)
                }
            } label: {
                HStack {
                    Text("#\(tag)").foregroundStyle(Tokens.Text.primary.color)
                    Spacer()
                    if selected.contains(tag) {
                        Image(systemName: "checkmark").foregroundStyle(Tokens.Text.tint.color)
                    }
                }
            }
            .accessibilityAddTraits(selected.contains(tag) ? .isSelected : [])
        }
        .navigationTitle("Also tagged")
    }
}
