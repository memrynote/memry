//
//  NoteMetadataEditor.swift
//  Title, icon, tags, properties and cover — the write half of a note's
//  metadata (N701 - N705).
//

import Foundation
import MemryCore
import Observation

/// What a metadata surface needs to write through.
///
/// One protocol so the editors can be driven by a fake in tests and by the
/// core in production, and so no view holds a `Vault`.
protocol NoteMetadataWriting: Sendable {
    func rename(id: String, title: String) async throws
    /// `nil` clears the icon, which writes an explicit null rather than
    /// removing the key (§13.4).
    func setIcon(id: String, icon: String?) async throws
    func setTags(id: String, tags: [String]) async throws
    /// Sets or clears a note's cover (N703). `nil` clears.
    func setCover(id: String, url: String?, offsetY: Double) async throws
    func setAliases(id: String, aliases: [String]) async throws
    /// The value is JSON text, because §13.7.1 lets a property hold any JSON
    /// and a closed enum would have to drop or coerce whatever did not fit.
    func setProperty(id: String, name: String, valueJson: String) async throws
    func clearProperty(id: String, name: String) async throws
    /// Renames one property on this note only, keeping its value; the old key
    /// is dropped rather than nulled (desktop `properties:rename`).
    func renameProperty(id: String, from: String, to: String) async throws
    /// Reorders this note's properties: `names` first in that order, the rest
    /// after (desktop `reorderProperties`). The order is the payload's key
    /// order, so it reaches desktop and comes back from it.
    func reorderProperties(id: String, names: [String]) async throws
    /// Creates the vault-wide definition for a new status, select or
    /// multiselect property when there is none (desktop
    /// `notes:create-property-definition`). An existing one is untouched.
    func ensurePropertyDefinition(name: String, typeName: String) async throws
}

/// A write this surface cannot make, such as renaming a journal day's property
/// before its writer supports it.
struct NoteMetadataWriteUnsupported: Error {}

extension NoteMetadataWriting {
    func renameProperty(id: String, from: String, to: String) async throws {
        throw NoteMetadataWriteUnsupported()
    }

    func reorderProperties(id: String, names: [String]) async throws {
        throw NoteMetadataWriteUnsupported()
    }

    /// No definition to create: the value is still written and draws as the
    /// type its value implies.
    func ensurePropertyDefinition(name: String, typeName: String) async throws {}
}

/// The production writer, over the shell's one serial core queue.
struct CoreNoteMetadataWriter: NoteMetadataWriting {
    private let vault: Vault
    private let store: any SecureStore
    private let executor: CoreExecutor

    init(vault: Vault, store: any SecureStore, executor: CoreExecutor) {
        self.vault = vault
        self.store = store
        self.executor = executor
    }

    /// Minted per write, for the reason `CoreNotesWriter` gives: a keychain
    /// locked when the edit happens is what matters, not whether it was locked
    /// when the screen opened.
    private func writer() throws -> NotesWriter {
        try vault.notesWriter(store: store)
    }

    func rename(id: String, title: String) async throws {
        try await executor.run { try writer().rename(id: id, title: title) }
    }

    func setIcon(id: String, icon: String?) async throws {
        try await executor.run { try writer().setIcon(id: id, icon: icon) }
    }

    func setTags(id: String, tags: [String]) async throws {
        try await executor.run { try writer().setTags(id: id, tags: tags) }
    }

    func setCover(id: String, url: String?, offsetY: Double) async throws {
        try await executor.run {
            try writer().setCover(id: id, url: url, offsetY: offsetY)
        }
    }

    func setAliases(id: String, aliases: [String]) async throws {
        try await executor.run { try writer().setAliases(id: id, aliases: aliases) }
    }

    func setProperty(id: String, name: String, valueJson: String) async throws {
        try await executor.run {
            try writer().setProperty(id: id, name: name, valueJson: valueJson)
        }
    }

    func clearProperty(id: String, name: String) async throws {
        try await executor.run { try writer().clearProperty(id: id, name: name) }
    }

    func renameProperty(id: String, from: String, to: String) async throws {
        try await executor.run {
            try writer().renameProperty(id: id, from: from, to: to)
        }
    }

    func reorderProperties(id: String, names: [String]) async throws {
        try await executor.run {
            try writer().reorderProperties(id: id, names: names)
        }
    }

    func ensurePropertyDefinition(name: String, typeName: String) async throws {
        try await executor.run {
            try vault.tasks(store: store).ensurePropertyDefinition(name: name, typeName: typeName)
        }
    }
}

/// The ten property types §13.7.1 allows, as the editors present them.
///
/// **Driven by the declared `type_name`, with a fallback that shows the raw
/// value.** A property written before its definition arrived carries no type
/// and is still a property the user wrote; a type this build has never heard
/// of is the same case one step further out. Neither may vanish.
enum NotePropertyKind: String, CaseIterable, Sendable {
    case text
    case number
    case date
    case checkbox
    case url
    case status
    case select
    case multiselect
    case relation
    case project

    /// The reserved name desktop keys the project link off
    /// (`PROJECT_PROPERTY_KEY`).
    static let projectName = "project"

    /// The declared type, else the one the value implies, else `nil` (text).
    ///
    /// Desktop's own ladder (`resolvePropertyType` in `vault/frontmatter.ts`):
    /// the reserved `project` name, then **a list of `memry://` URIs is a
    /// relation whatever the definition says** (a relation's definition is
    /// never persisted, so the value is the only reliable witness), then the
    /// definition, then inference from the value (`inferPropertyType`).
    static func of(_ property: NoteProperty) -> NotePropertyKind? {
        if property.name == projectName { return .project }
        if isRelationValue(property.valueJson) { return .relation }
        if let declared = property.typeName.flatMap({ NotePropertyKind(rawValue: $0) }) {
            return declared
        }
        return inferred(from: property.valueJson)
    }

    /// `inferPropertyType`: a boolean is a checkbox, a number a number, an ISO
    /// date string a date, an http(s) string a url. Anything else is `nil`,
    /// which edits as text.
    static func inferred(from json: String) -> NotePropertyKind? {
        guard
            let value = try? JSONSerialization.jsonObject(
                with: Data(json.utf8),
                options: [.fragmentsAllowed]
            )
        else { return nil }
        if let number = value as? NSNumber {
            return CFGetTypeID(number) == CFBooleanGetTypeID() ? .checkbox : .number
        }
        guard let text = value as? String else { return nil }
        if NotePropertyDate.isISODate(text) { return .date }
        if let url = URL(string: text), let scheme = url.scheme?.lowercased(),
            scheme == "http" || scheme == "https", url.host() != nil
        {
            return .url
        }
        return nil
    }

    /// The label desktop gives each type (`PROPERTY_TYPE_CONFIG`), which is
    /// also the name a new property takes when none is typed.
    var label: String {
        switch self {
        case .text: "Text"
        case .number: "Number"
        case .date: "Date"
        case .checkbox: "Checkbox"
        case .url: "URL"
        case .status: "Status"
        case .select: "Select"
        case .multiselect: "Multiselect"
        case .relation: "Relation"
        case .project: "Project"
        }
    }

    var symbol: String {
        switch self {
        case .text: "textformat"
        case .number: "number"
        case .date: "calendar"
        case .checkbox: "checkmark.square"
        case .url: "link"
        case .status: "checklist"
        case .select: "list.bullet"
        case .multiselect: "square.stack"
        case .relation: "arrow.up.right.square"
        case .project: "folder"
        }
    }

    /// Whether adding one creates a vault-wide definition first, as desktop's
    /// `handleAddProperty` does for the choice types.
    var needsDefinition: Bool { isChoice }

    /// The JSON a new property starts with (`getDefaultValueForType`). A date
    /// starts at now, as desktop's `new Date().toISOString()` does.
    func defaultValueJSON(now: Date = Date()) -> String {
        switch self {
        case .checkbox: "false"
        case .number: "0"
        case .date: "\"\(NotePropertyDate.encode(now))\""
        case .multiselect, .relation, .project: "[]"
        case .status, .select: "null"
        case .url, .text: "\"\""
        }
    }

    /// `memry://<kind>/<id>` strings, at least one, and nothing else.
    static func isRelationValue(_ json: String) -> Bool {
        guard
            let parsed = try? JSONSerialization.jsonObject(with: Data(json.utf8)),
            let values = parsed as? [String],
            !values.isEmpty
        else { return false }
        return values.allSatisfy { $0.hasPrefix("memry://") }
    }

    /// Whether the editor offers a fixed set of choices.
    var isChoice: Bool {
        self == .status || self == .select || self == .multiselect
    }
}

/// A date property's value, read and written as desktop does.
///
/// Desktop writes `Date.toISOString()` of the picked day's local midnight
/// (`PropertyRow` → `DateEditor`), and older values may be a bare
/// `YYYY-MM-DD`. Both read; a bare day is taken as that calendar day here so
/// it does not shift by a time zone.
enum NotePropertyDate {
    /// Desktop's `isISODate` shape.
    static func isISODate(_ text: String) -> Bool {
        text.wholeMatch(of: /\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{3})?Z?)?/) != nil
            && parse(text) != nil
    }

    static func parse(_ text: String, calendar: Calendar = .current) -> Date? {
        let trimmed = text.trimmingCharacters(in: .whitespaces)
        if trimmed.count == 10 {
            let parts = trimmed.split(separator: "-").compactMap { Int($0) }
            guard parts.count == 3 else { return nil }
            let components = DateComponents(year: parts[0], month: parts[1], day: parts[2])
            guard components.isValidDate(in: calendar) else { return nil }
            return calendar.date(from: components)
        }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: trimmed) { return date }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        if let date = plain.date(from: trimmed) { return date }
        // Desktop's pattern allows a missing `Z`, read as UTC like the rest.
        return plain.date(from: trimmed + "Z")
    }

    /// The stored form of a picked day: its local midnight as
    /// `toISOString()` spells it, `2026-10-20T21:00:00.000Z`.
    static func encode(day: Date, calendar: Calendar = .current) -> String {
        encode(calendar.startOfDay(for: day))
    }

    static func encode(_ instant: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        return formatter.string(from: instant)
    }

    /// What the row shows: the day, abbreviated in the reader's locale.
    static func display(_ text: String) -> String? {
        parse(text).map { $0.formatted(.dateTime.day().month(.abbreviated).year()) }
    }
}

/// A new property's name, as desktop's add-property flow picks it
/// (`AddPropertyPopup` + `getUniquePropertyName`).
enum NewPropertyName {
    /// `nil` when nothing may be added: a second `project`, which desktop
    /// shows disabled because the link is keyed off that one name.
    static func resolve(typed: String, kind: NotePropertyKind, existing: [String]) -> String? {
        if kind == .project {
            return existing.contains(NotePropertyKind.projectName) ? nil : NotePropertyKind.projectName
        }
        let trimmed = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        return unique(trimmed.isEmpty ? kind.label : trimmed, existing: existing)
    }

    static func unique(_ base: String, existing: [String]) -> String {
        guard existing.contains(base) else { return base }
        var counter = 2
        while existing.contains("\(base) \(counter)") { counter += 1 }
        return "\(base) \(counter)"
    }
}

/// The tag field's suggestions, after desktop's `TagInputPopup`: every tag
/// the note does not carry, narrowed by a case-insensitive substring of what
/// is typed, and a create offer when nothing in the vault is spelled that way.
enum NoteTagSuggestions {
    static func matching(_ query: String, all: [String], current: [String]) -> [String] {
        let typed = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let carried = Set(current.map { $0.lowercased() })
        return all.filter { tag in
            !carried.contains(tag.lowercased())
                && (typed.isEmpty || tag.lowercased().contains(typed))
        }
    }

    /// The text to offer as a new tag, or `nil` when it is empty or the vault
    /// or this note already spells it (case folded).
    static func createCandidate(_ query: String, all: [String], current: [String]) -> String? {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let taken = (all + current).contains { $0.caseInsensitiveCompare(trimmed) == .orderedSame }
        return taken ? nil : trimmed
    }

    /// What return adds: an existing tag spelled that way (its stored
    /// spelling), else the typed text as a new tag.
    static func commitTarget(_ query: String, all: [String]) -> String? {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        return all.first { $0.caseInsensitiveCompare(trimmed) == .orderedSame } ?? trimmed
    }
}

/// A relation's value: `memry://<kind>/<id>` strings (`relation-uri.ts`).
enum NoteRelationValue {
    static func uri(noteId: String) -> String { "memry://note/\(noteId)" }

    static func uris(_ json: String) -> [String] {
        guard
            let parsed = try? JSONSerialization.jsonObject(with: Data(json.utf8)),
            let values = parsed as? [String]
        else { return [] }
        return values
    }

    /// The id a URI names, or the URI itself when it is not one.
    static func id(of uri: String) -> String {
        guard uri.hasPrefix("memry://") else { return uri }
        return uri.split(separator: "/").last.map(String.init) ?? uri
    }

    static func json(_ uris: [String]) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: uris, options: [.withoutEscapingSlashes])
        else { return "[]" }
        return String(decoding: data, as: UTF8.self)
    }
}

/// The choices a property definition declares, in the order it declares
/// them.
///
/// Two shapes exist on the wire. A `select` or `multiselect` holds a list of
/// options; a `status` holds **categories**, each with its own options
/// (`.memry/properties.md`). Reading only the first shape gave every status an
/// empty picker, which drew as a blank control with the note's value hidden.
enum NotePropertyOptions {
    /// Desktop's category order. JSON objects carry none, so it is restated
    /// here; a category this build does not know follows, by name.
    private static let statusOrder = ["todo", "in_progress", "done"]

    /// Each option's palette colour name, by value. An option with no colour
    /// is absent and draws in the neutral chip.
    static func colors(of json: String?) -> [String: String] {
        guard
            let json,
            let parsed = try? JSONSerialization.jsonObject(with: Data(json.utf8))
        else { return [:] }
        var objects: [[String: Any]] = parsed as? [[String: Any]] ?? []
        if let categories = (parsed as? [String: Any])?["categories"] as? [String: Any] {
            objects = categories.values.flatMap {
                ($0 as? [String: Any])?["options"] as? [[String: Any]] ?? []
            }
        }
        var out: [String: String] = [:]
        for object in objects {
            if let value = object["value"] as? String, let color = object["color"] as? String {
                out[value] = color
            }
        }
        return out
    }

    static func values(of json: String?) -> [String] {
        guard
            let json,
            let parsed = try? JSONSerialization.jsonObject(with: Data(json.utf8))
        else { return [] }
        if let categories = (parsed as? [String: Any])?["categories"] as? [String: Any] {
            let known = statusOrder.filter { categories[$0] != nil }
            let rest = categories.keys.filter { !statusOrder.contains($0) }.sorted()
            return (known + rest).flatMap { key in
                list((categories[key] as? [String: Any])?["options"])
            }
        }
        return list(parsed)
    }

    private static func list(_ value: Any?) -> [String] {
        if let strings = value as? [String] { return strings }
        if let objects = value as? [[String: Any]] {
            return objects.compactMap { $0["value"] as? String ?? $0["name"] as? String }
        }
        return []
    }
}

/// Turns what a user typed into the JSON the payload carries.
///
/// **Separate from the views so the mapping can be asserted over values.**
/// Getting this wrong is not a cosmetic bug: a number written as `"3"` is a
/// different JSON type from `3`, and FR-048 then refuses every later edit of
/// that property as a retype.
enum NotePropertyJSON {
    /// The JSON text for one edited value.
    ///
    /// - Returns: `nil` when the input cannot be represented as the declared
    ///   type — an unparseable number, say — so the caller can refuse rather
    ///   than write something the user did not mean.
    static func encode(_ input: String, as kind: NotePropertyKind?) -> String? {
        switch kind {
        case .number:
            // A number must land as a JSON number. Written as text it would
            // retype the property and FR-048 would refuse every later edit.
            guard let value = Double(input.trimmingCharacters(in: .whitespaces)) else {
                return nil
            }
            return value == value.rounded() && abs(value) < 1e15
                ? String(Int64(value))
                : String(value)
        case .checkbox:
            return input == "true" ? "true" : "false"
        case .multiselect, .relation:
            // A list, even when it holds one entry: the type is the array.
            let parts = input
                .split(separator: ",")
                .map { $0.trimmingCharacters(in: .whitespaces) }
                .filter { !$0.isEmpty }
            return encodeJSON(parts)
        case .text, .date, .url, .status, .select, .project, .none:
            // Everything else is a string, including an unknown type: a string
            // is what the user typed, and inventing a shape for a type this
            // build does not know would be a guess.
            return encodeJSON(input)
        }
    }

    /// The text an editor starts from, for a value the payload already holds.
    static func decode(_ property: NoteProperty) -> String {
        guard
            let value = try? JSONSerialization.jsonObject(
                with: Data(property.valueJson.utf8),
                options: [.fragmentsAllowed]
            )
        else {
            return property.valueJson
        }
        switch value {
        case is NSNull:
            return ""
        case let text as String:
            return text
        case let flag as Bool:
            return flag ? "true" : "false"
        case let list as [Any]:
            return list.map { "\($0)" }.joined(separator: ", ")
        case let number as NSNumber:
            return number.stringValue
        default:
            return property.valueJson
        }
    }

    private static func encodeJSON(_ value: Any) -> String? {
        guard
            let data = try? JSONSerialization.data(
                withJSONObject: value,
                options: [.fragmentsAllowed]
            )
        else {
            return nil
        }
        return String(decoding: data, as: UTF8.self)
    }
}

/// A note's cover, as the shell can understand it.
///
/// **`coverImage` is not a field of the note schema** — §13.7.1 does not list
/// it and the vectors use it as their canonical *unknown key*. The core
/// therefore hands over whatever JSON the payload holds, and this reads the
/// one shape that has been seen in the wild without ever claiming the key is
/// defined. An unrecognised shape draws nothing rather than a broken frame.
struct NoteCover: Equatable, Sendable {
    let url: String
    /// Where the image sits vertically in its frame, 0...1.
    let offsetY: Double

    static func of(_ json: String?) -> NoteCover? {
        guard
            let json,
            let object = try? JSONSerialization.jsonObject(with: Data(json.utf8)),
            let fields = object as? [String: Any],
            let url = fields["url"] as? String,
            !url.isEmpty
        else {
            return nil
        }
        let offset = (fields["offsetY"] as? NSNumber)?.doubleValue ?? 0.5
        return NoteCover(url: url, offsetY: min(max(offset, 0), 1))
    }
}

/// The editing state of one note's metadata.
@MainActor
@Observable
final class NoteMetadataViewModel {
    enum Status: Equatable {
        case idle
        case saving
        case failed(UserFacingError)
    }

    private let noteId: String
    private let writer: (any NoteMetadataWriting)?

    private(set) var status: Status = .idle

    init(noteId: String, writer: (any NoteMetadataWriting)?) {
        self.noteId = noteId
        self.writer = writer
    }

    /// Absent rather than disabled: with no writer there is nothing to write
    /// through, and a field that cannot save is worse than no field.
    var canEdit: Bool { writer != nil }

    /// Renames the note (N702).
    ///
    /// An unchanged title writes nothing: every write is a payload merge and
    /// an outbox row, and tapping into the title and back out must not enqueue
    /// a push.
    func rename(to title: String, current: String) async {
        guard let writer, title != current else { return }
        await run { try await writer.rename(id: noteId, title: title) }
    }

    /// Sets or clears the icon (N702). `nil` clears.
    func setIcon(_ icon: String?) async {
        guard let writer else { return }
        await run { try await writer.setIcon(id: noteId, icon: icon) }
    }

    /// Adds a tag by writing the whole list back, which is the shape of the
    /// field. A duplicate is a no-op rather than a second row.
    func addTag(_ tag: String, to tags: [String]) async -> [String] {
        let trimmed = tag.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !tags.contains(trimmed) else { return tags }
        let next = tags + [trimmed]
        await setTags(next)
        return next
    }

    func removeTag(_ tag: String, from tags: [String]) async -> [String] {
        let next = tags.filter { $0 != tag }
        guard next.count != tags.count else { return tags }
        await setTags(next)
        return next
    }

    /// Tags are a **field of the note payload** (§13.7.1), not a property.
    /// The tag rows one layer down are a projection of this array, so this is
    /// what makes a tag exist.
    func setTags(_ tags: [String]) async {
        guard let writer else { return }
        await run { try await writer.setTags(id: noteId, tags: tags) }
    }

    /// Sets or clears the cover (N703).
    ///
    /// **`coverImage` is not a field of the note schema.** Writing it is safe
    /// because §13.2 makes an unknown top-level payload key something every
    /// conforming client carries, and §13.2.1 records how desktop does it, so
    /// a cover written here survives an older desktop editing the note. No
    /// other client renders one today — a product gap rather than a protocol
    /// one, recorded in `research.md`.
    func setCover(url: String?, offsetY: Double) async {
        guard let writer else { return }
        await run { try await writer.setCover(id: noteId, url: url, offsetY: offsetY) }
    }

    func setAliases(_ aliases: [String]) async {
        guard let writer else { return }
        await run { try await writer.setAliases(id: noteId, aliases: aliases) }
    }

    /// Writes one property (N704).
    ///
    /// - Returns: `false` when the input cannot be represented as the declared
    ///   type, in which case **nothing is written**: guessing would retype the
    ///   property and FR-048 would then refuse every later edit of it.
    @discardableResult
    func setProperty(_ name: String, input: String, kind: NotePropertyKind?) async -> Bool {
        guard let writer else { return false }
        guard let json = NotePropertyJSON.encode(input, as: kind) else {
            status = .failed(
                UserFacingError(
                    code: "property.unrepresentable",
                    title: "That is not a valid value for this property.",
                    guidance: "Check the type and try again. Nothing was changed.",
                    recourse: .retry,
                    isUserVisible: true
                )
            )
            return false
        }
        await run {
            try await writer.setProperty(id: noteId, name: name, valueJson: json)
        }
        return status == .idle
    }

    /// Clears a property, leaving the key present and null (§13.4).
    func clearProperty(_ name: String) async {
        guard let writer else { return }
        await run { try await writer.clearProperty(id: noteId, name: name) }
    }

    /// Renames a property on this note only, as desktop's `properties:rename`
    /// does. An empty or unchanged name writes nothing; a name the note
    /// already carries is refused here, before a write, with the same answer
    /// desktop gives.
    ///
    /// - Returns: the name the property now has.
    @discardableResult
    func renameProperty(_ name: String, to typed: String, existing: [String]) async -> String {
        guard let writer else { return name }
        let next = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !next.isEmpty, next != name else { return name }
        guard !existing.contains(next) else {
            status = .failed(
                UserFacingError(
                    code: "property.nameTaken",
                    title: "This note already has a property named \(next).",
                    guidance: "Choose another name. Nothing was changed.",
                    recourse: .retry,
                    isUserVisible: true
                )
            )
            return name
        }
        await run { try await writer.renameProperty(id: noteId, from: name, to: next) }
        return status == .idle ? next : name
    }

    /// Reorders the note's properties (desktop `reorderProperties`). An
    /// unchanged order writes nothing.
    func reorderProperties(_ names: [String], current: [String]) async {
        guard let writer, names != current else { return }
        await run { try await writer.reorderProperties(id: noteId, names: names) }
    }

    /// Adds a property with desktop's default value for its type, creating
    /// the vault-wide definition first for a choice type
    /// (`use-property-section.ts` `handleAddProperty`).
    ///
    /// - Returns: the name written, or `nil` when nothing was (a second
    ///   `project`, or a failed write).
    func addProperty(named typed: String, kind: NotePropertyKind, existing: [String]) async -> String? {
        guard let writer,
            let name = NewPropertyName.resolve(typed: typed, kind: kind, existing: existing)
        else { return nil }
        let value = kind.defaultValueJSON()
        await run {
            if kind.needsDefinition {
                try await writer.ensurePropertyDefinition(name: name, typeName: kind.rawValue)
            }
            try await writer.setProperty(id: noteId, name: name, valueJson: value)
        }
        return status == .idle ? name : nil
    }

    /// Writes a relation's whole list, as desktop's `RelationEditor` does on
    /// an add or a remove. A URI already present is not added twice.
    func setRelations(_ name: String, _ uris: [String]) async {
        guard let writer else { return }
        var seen = Set<String>()
        let unique = uris.filter { seen.insert($0).inserted }
        let json = NoteRelationValue.json(unique)
        await run { try await writer.setProperty(id: noteId, name: name, valueJson: json) }
    }

    func dismissFailure() { status = .idle }

    private func run(_ work: () async throws -> Void) async {
        status = .saving
        do {
            try await work()
            status = .idle
        } catch {
            Log.storage.error("a metadata write did not land")
            status = .failed(ErrorMapping.userFacing(error))
        }
    }
}
