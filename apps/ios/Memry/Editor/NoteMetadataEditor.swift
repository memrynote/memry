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

    /// The declared type, or `nil` for one this build does not know.
    static func of(_ property: NoteProperty) -> NotePropertyKind? {
        property.typeName.flatMap { NotePropertyKind(rawValue: $0) }
    }

    /// Whether the editor offers a fixed set of choices.
    var isChoice: Bool {
        self == .status || self == .select || self == .multiselect
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
    private func setTags(_ tags: [String]) async {
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
