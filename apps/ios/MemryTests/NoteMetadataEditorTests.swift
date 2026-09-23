//
//  NoteMetadataEditorTests.swift
//  N701 - N705, held to the shapes the payload really carries.
//

import Foundation
import MemryCore
import Synchronization
import Testing

@testable import Memry

/// Records every metadata write it is asked to make.
private final class ScriptedMetadataWriter: NoteMetadataWriting, @unchecked Sendable {
    enum Call: Equatable {
        case rename(String)
        case icon(String?)
        case tags([String])
        case aliases([String])
        case cover(String?, Double)
        case property(String, String)
        case clear(String)
    }

    let calls = Mutex<[Call]>([])
    private let failure: Error?

    init(failure: Error? = nil) {
        self.failure = failure
    }

    private func record(_ call: Call) throws {
        calls.withLock { $0.append(call) }
        if let failure { throw failure }
    }

    func rename(id: String, title: String) async throws { try record(.rename(title)) }
    func setIcon(id: String, icon: String?) async throws { try record(.icon(icon)) }
    func setTags(id: String, tags: [String]) async throws { try record(.tags(tags)) }
    func setAliases(id: String, aliases: [String]) async throws { try record(.aliases(aliases)) }
    func setCover(id: String, url: String?, offsetY: Double) async throws {
        try record(.cover(url, offsetY))
    }
    func setProperty(id: String, name: String, valueJson: String) async throws {
        try record(.property(name, valueJson))
    }
    func clearProperty(id: String, name: String) async throws { try record(.clear(name)) }

    var all: [Call] { calls.withLock { $0 } }
}

private func property(
    _ name: String,
    _ valueJson: String,
    type: String? = nil,
    options: String? = nil
) -> NoteProperty {
    NoteProperty(
        name: name,
        valueJson: valueJson,
        typeName: type,
        optionsJson: options,
        color: nil
    )
}

@Suite("N704 property values become the JSON the payload carries")
struct NotePropertyJSONTests {

    /// **A number must land as a JSON number.**
    ///
    /// Written as text it would retype the property, and FR-048 would then
    /// refuse every later edit of it. This is the encoding bug that is
    /// invisible until the second edit.
    @Test func a_number_encodes_as_a_number_not_a_string() {
        #expect(NotePropertyJSON.encode("42", as: .number) == "42")
        #expect(NotePropertyJSON.encode(" 42 ", as: .number) == "42")
        #expect(NotePropertyJSON.encode("3.5", as: .number) == "3.5")
        // And something that is not a number is refused rather than guessed,
        // so the caller can decline to write.
        #expect(NotePropertyJSON.encode("forty two", as: .number) == nil)
    }

    @Test func a_checkbox_encodes_as_a_boolean() {
        #expect(NotePropertyJSON.encode("true", as: .checkbox) == "true")
        #expect(NotePropertyJSON.encode("false", as: .checkbox) == "false")
        // Anything that is not "true" is false, rather than a third state.
        #expect(NotePropertyJSON.encode("", as: .checkbox) == "false")
    }

    /// The two array types stay arrays even with one entry: the type is the
    /// array, and a bare string would retype the property.
    @Test func the_list_types_encode_as_arrays() {
        #expect(NotePropertyJSON.encode("one, two", as: .multiselect) == "[\"one\",\"two\"]")
        #expect(NotePropertyJSON.encode("only", as: .relation) == "[\"only\"]")
        #expect(NotePropertyJSON.encode("", as: .multiselect) == "[]")
    }

    @Test func the_string_types_encode_as_strings() {
        for kind: NotePropertyKind in [.text, .date, .url, .status, .select, .project] {
            #expect(
                NotePropertyJSON.encode("a value", as: kind) == "\"a value\"",
                "\(kind) must encode as a string"
            )
        }
    }

    /// **A type this build has never heard of still edits**, as text. A
    /// property written before its definition arrived is legal (§13.7.1) and
    /// is exactly the case that would otherwise be unreachable.
    @Test func an_unknown_type_encodes_as_text_rather_than_being_refused() {
        #expect(NotePropertyJSON.encode("something", as: nil) == "\"something\"")
    }

    /// Decoding is what an editor starts from, and it must survive every
    /// shape the payload can hold.
    @Test func decoding_gives_the_editor_something_to_start_from() {
        #expect(NotePropertyJSON.decode(property("a", "\"text\"")) == "text")
        #expect(NotePropertyJSON.decode(property("a", "42")) == "42")
        #expect(NotePropertyJSON.decode(property("a", "true")) == "true")
        #expect(NotePropertyJSON.decode(property("a", "[\"x\",\"y\"]")) == "x, y")
        // A cleared property is empty rather than the word "null", which is
        // the wire's word and not the user's.
        #expect(NotePropertyJSON.decode(property("a", "null")) == "")
    }

    /// A round trip must not change the JSON type, or the second edit is a
    /// retype the core refuses.
    @Test func a_round_trip_preserves_the_json_type() {
        let cases: [(String, NotePropertyKind)] = [
            ("42", .number),
            ("true", .checkbox),
            ("[\"x\",\"y\"]", .multiselect),
            ("\"text\"", .text),
        ]
        for (json, kind) in cases {
            let text = NotePropertyJSON.decode(property("a", json, type: kind.rawValue))
            #expect(
                NotePropertyJSON.encode(text, as: kind) == json,
                "\(kind) did not round-trip: \(json) -> \(text)"
            )
        }
    }
}

@Suite("N208 a cover is read from an unknown payload key")
struct NoteCoverTests {

    /// The one shape seen in the wild is understood; nothing else claims the
    /// key is defined.
    @Test func a_recognised_cover_shape_is_read() {
        let cover = NoteCover.of("{\"url\":\"memry://cover/1\",\"offsetY\":0.25}")
        #expect(cover?.url == "memry://cover/1")
        #expect(cover?.offsetY == 0.25)
    }

    /// **An unrecognised shape draws nothing rather than a broken frame.**
    /// `coverImage` is an unknown key, so this client must not assume it
    /// knows what is inside.
    @Test func an_unrecognised_shape_is_ignored_rather_than_guessed_at() {
        #expect(NoteCover.of(nil) == nil)
        #expect(NoteCover.of("null") == nil)
        #expect(NoteCover.of("\"just a string\"") == nil)
        #expect(NoteCover.of("{\"notUrl\":1}") == nil)
        #expect(NoteCover.of("{\"url\":\"\"}") == nil)
        #expect(NoteCover.of("not json at all") == nil)
    }

    /// A missing offset centres rather than failing, and a wild one is
    /// clamped: the offset decides what is visible, so an out-of-range value
    /// would show an empty frame.
    @Test func the_offset_defaults_and_clamps() {
        #expect(NoteCover.of("{\"url\":\"u\"}")?.offsetY == 0.5)
        #expect(NoteCover.of("{\"url\":\"u\",\"offsetY\":9}")?.offsetY == 1)
        #expect(NoteCover.of("{\"url\":\"u\",\"offsetY\":-4}")?.offsetY == 0)
    }
}

@Suite("N702 / N705 the metadata writes")
@MainActor
struct NoteMetadataViewModelTests {

    @Test func renaming_reaches_the_core() async {
        let writer = ScriptedMetadataWriter()
        let model = NoteMetadataViewModel(noteId: "note-1", writer: writer)

        await model.rename(to: "A new title", current: "Old")

        #expect(writer.all == [.rename("A new title")])
        #expect(model.status == .idle)
    }

    /// An unchanged title writes nothing: every write is a payload merge and
    /// an outbox row, so tapping in and out must not enqueue a push.
    @Test func renaming_to_the_same_title_writes_nothing() async {
        let writer = ScriptedMetadataWriter()
        let model = NoteMetadataViewModel(noteId: "note-1", writer: writer)

        await model.rename(to: "Same", current: "Same")

        #expect(writer.all.isEmpty)
    }

    /// Clearing an icon is `nil`, which the core writes as an explicit null
    /// rather than removing the key (§13.4).
    @Test func the_icon_sets_and_clears() async {
        let writer = ScriptedMetadataWriter()
        let model = NoteMetadataViewModel(noteId: "note-1", writer: writer)

        await model.setIcon("🌱")
        await model.setIcon(nil)

        #expect(writer.all == [.icon("🌱"), .icon(nil)])
    }

    /// **Tags are written as the whole array**, because that is the shape of
    /// the payload field and of §13.2's field-level merge.
    @Test func adding_a_tag_writes_the_whole_array() async {
        let writer = ScriptedMetadataWriter()
        let model = NoteMetadataViewModel(noteId: "note-1", writer: writer)

        let next = await model.addTag("research", to: ["existing"])

        #expect(next == ["existing", "research"])
        #expect(writer.all == [.tags(["existing", "research"])])
    }

    /// A duplicate is a no-op rather than a second entry, and it writes
    /// nothing at all.
    @Test func adding_a_tag_the_note_already_has_writes_nothing() async {
        let writer = ScriptedMetadataWriter()
        let model = NoteMetadataViewModel(noteId: "note-1", writer: writer)

        let next = await model.addTag("existing", to: ["existing"])

        #expect(next == ["existing"])
        #expect(writer.all.isEmpty)
    }

    @Test func removing_a_tag_writes_the_remainder() async {
        let writer = ScriptedMetadataWriter()
        let model = NoteMetadataViewModel(noteId: "note-1", writer: writer)

        let next = await model.removeTag("gone", from: ["kept", "gone"])

        #expect(next == ["kept"])
        #expect(writer.all == [.tags(["kept"])])
    }

    /// Removing a tag the note does not carry writes nothing.
    @Test func removing_an_absent_tag_writes_nothing() async {
        let writer = ScriptedMetadataWriter()
        let model = NoteMetadataViewModel(noteId: "note-1", writer: writer)

        _ = await model.removeTag("never", from: ["kept"])

        #expect(writer.all.isEmpty)
    }

    /// **An unrepresentable value writes nothing**, rather than guessing a
    /// shape that would retype the property and make FR-048 refuse every
    /// later edit.
    @Test func a_value_that_cannot_be_represented_writes_nothing() async {
        let writer = ScriptedMetadataWriter()
        let model = NoteMetadataViewModel(noteId: "note-1", writer: writer)

        let wrote = await model.setProperty("count", input: "not a number", kind: .number)

        #expect(!wrote)
        #expect(writer.all.isEmpty, "nothing may be written for a value we cannot encode")
        guard case let .failed(error) = model.status else {
            Issue.record("expected a failure, got \(model.status)")
            return
        }
        #expect(!error.title.isEmpty)
    }

    @Test func a_property_write_carries_the_encoded_json() async {
        let writer = ScriptedMetadataWriter()
        let model = NoteMetadataViewModel(noteId: "note-1", writer: writer)

        await model.setProperty("count", input: "7", kind: .number)

        #expect(writer.all == [.property("count", "7")])
    }

    @Test func clearing_a_property_reaches_the_core() async {
        let writer = ScriptedMetadataWriter()
        let model = NoteMetadataViewModel(noteId: "note-1", writer: writer)

        await model.clearProperty("count")

        #expect(writer.all == [.clear("count")])
    }

    /// A failed write is mapped through `ErrorMapping`, never raw.
    @Test func a_failed_write_is_mapped() async {
        let writer = ScriptedMetadataWriter(
            failure: StorageError.Failed(what: "the disk is full")
        )
        let model = NoteMetadataViewModel(noteId: "note-1", writer: writer)

        await model.rename(to: "New", current: "Old")

        guard case let .failed(error) = model.status else {
            Issue.record("expected a failure, got \(model.status)")
            return
        }
        #expect(error.code != ErrorMapping.unrecognised.code)
        // Constitution II: the payload must not be echoed at the user.
        #expect(!(error.guidance ?? "").contains("the disk is full"))
    }

    /// **Absent, not disabled.** With no writer there is nothing to write
    /// through, so no field may offer to save.
    @Test func a_note_with_no_writer_cannot_be_edited() async {
        let model = NoteMetadataViewModel(noteId: "note-1", writer: nil)
        #expect(!model.canEdit)

        await model.rename(to: "New", current: "Old")
        await model.setIcon("🌱")
        #expect(model.status == .idle)
    }

    // MARK: - The cover (N703)

    /// A cover stores the **url** the reader resolves, not an attachment id:
    /// Q4 binds a block url to an attachment by its filename's basename, so an
    /// id here would be something the reader cannot resolve.
    @Test func setting_a_cover_writes_its_url_and_offset() async {
        let writer = ScriptedMetadataWriter()
        let model = NoteMetadataViewModel(noteId: "note-1", writer: writer)

        await model.setCover(url: "cover.png", offsetY: 0.25)

        #expect(writer.all == [.cover("cover.png", 0.25)])
    }

    /// Removing a cover is `nil`, which the core writes as an explicit null
    /// rather than removing the key (§13.4).
    @Test func removing_a_cover_sends_nil() async {
        let writer = ScriptedMetadataWriter()
        let model = NoteMetadataViewModel(noteId: "note-1", writer: writer)

        await model.setCover(url: nil, offsetY: 0.5)

        #expect(writer.all == [.cover(nil, 0.5)])
    }

    /// Repositioning keeps the same picture and moves only what is visible.
    @Test func repositioning_keeps_the_picture() async {
        let writer = ScriptedMetadataWriter()
        let model = NoteMetadataViewModel(noteId: "note-1", writer: writer)

        await model.setCover(url: "cover.png", offsetY: 0.0)
        await model.setCover(url: "cover.png", offsetY: 1.0)

        #expect(writer.all == [.cover("cover.png", 0.0), .cover("cover.png", 1.0)])
    }

    /// A read-only note offers no cover at all.
    @Test func a_note_with_no_writer_cannot_set_a_cover() async {
        let model = NoteMetadataViewModel(noteId: "note-1", writer: nil)
        await model.setCover(url: "cover.png", offsetY: 0.5)
        #expect(model.status == .idle)
    }
}
