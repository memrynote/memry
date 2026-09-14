import Foundation
import MemryCore
import Synchronization
import Testing

@testable import Memry

// T157. One note, read-only, and the one rule with teeth.
//
// **Four outcomes, four screens.** A read that threw, a read that returned
// `nil`, a body this device has not pulled, and a body the user left empty are
// four different facts, and this suite asserts each one against the other
// three rather than only against itself. Collapsing any pair reports an unread
// note as an empty one — the failure `domain/reads.rs` says its whole module
// was written against, and the failure this project has already shipped twice
// in another costume.
//
// **A preview is not a render** (spec-defect 125, Kaan's decision). The body is
// `extract_text` output, so `# Heading` is the text of a heading and
// `**bold**` is literal. The suite pins that the string crosses **verbatim**,
// because the tempting bug here is a helpful markdown pass that makes the
// preview look right and makes it lie.
//
// The source-structure half runs off `#filePath`, so it runs on a simulator or
// a Mac and genuinely **skips** on a device where the checkout is absent.
// `.enabled(if:)` skips; `#require` would have failed (spec-defect 115).

private struct NotScripted: Error {}
private struct NoteUnreadable: Error {}

/// A scripted reader for one note.
///
/// `folders()` and `list()` **throw**: nothing in this suite browses, so a
/// note screen that started listing a vault must be visible here rather than
/// quietly satisfied (`contracts/core-api.md`, the fake rule).
private final class ScriptedNoteReader: NotesReading, @unchecked Sendable {
    private let answer: Result<NoteDetail?, any Error>
    private let calls = Mutex<[String]>([])

    init(_ answer: Result<NoteDetail?, any Error>) {
        self.answer = answer
    }

    var callLog: [String] { calls.withLock { $0 } }

    func folders() async throws -> [FolderSummary] { throw NotScripted() }

    func list() async throws -> [NoteSummary] { throw NotScripted() }

    func read(id: String) async throws -> NoteDetail? {
        calls.withLock { $0.append("read:\(id)") }
        return try answer.get()
    }
}

private func summary(_ id: String, title: String = "A note") -> NoteSummary {
    NoteSummary(id: id, title: title, folderPath: nil, emoji: nil, createdAt: nil, modifiedAt: nil)
}

private func detail(
    _ id: String = "n1",
    title: String = "A note",
    text: String = "",
    present: Bool = true
) -> NoteDetail {
    NoteDetail(summary: summary(id, title: title), body: NoteBody(text: text, present: present))
}

/// `@MainActor` because ``NoteReadViewModel`` is: a view model that a view
/// mutates during `body` has no business being reachable from anywhere else.
@MainActor
private func makeModel(_ answer: Result<NoteDetail?, any Error>, id: String = "n1")
    -> (NoteReadViewModel, ScriptedNoteReader) {
    let reader = ScriptedNoteReader(answer)
    return (NoteReadViewModel(route: NoteRoute(id: id), reader: reader), reader)
}

/// What the user would see, as a comparable key: which screen, and which body.
///
/// Deliberately **not** the phase's payload. A key that included `NoteDetail`
/// would stay distinct for an unpulled and an empty body even if both rendered
/// the same screen, and would pass under the exact bug it is written for.
@MainActor
private func outcomeKey(_ model: NoteReadViewModel) -> String {
    let screen: String
    switch model.phase {
    case .loading: screen = "loading"
    case .ready: screen = "ready"
    case .missing: screen = "missing"
    case .unreadable: screen = "unreadable"
    }
    return "\(screen)/\(String(describing: model.preview))"
}

@MainActor
@Suite("T157 note read")
struct NoteReadTests {
    // MARK: The four outcomes, each against the other three

    @Test("a read that throws is unreadable — never missing, and never an empty note")
    func aThrownReadIsUnreadable() async {
        let (model, _) = makeModel(.failure(NoteUnreadable()))
        await model.loadIfNeeded()
        #expect(model.phase != .missing)
        #expect(model.preview == nil)
        guard case .unreadable = model.phase else {
            Issue.record("a read that threw must render as a failure")
            return
        }
    }

    @Test("a read that returns nil is missing — never a failure, and never an empty note")
    func aNilReadIsMissing() async {
        let (model, _) = makeModel(.success(nil))
        await model.loadIfNeeded()
        #expect(model.phase == .missing)
        #expect(model.preview == nil)
    }

    @Test("a body this device has not pulled is not an empty note")
    func anUnpulledBodyIsNotEmpty() async {
        let (model, _) = makeModel(.success(detail(text: "", present: false)))
        await model.loadIfNeeded()
        #expect(model.preview == .notPulled)
        #expect(model.preview != .empty)
        #expect(model.phase != .missing)
    }

    @Test("a body the user left empty is not an unpulled one")
    func anEmptyBodyIsNotUnpulled() async {
        let (model, _) = makeModel(.success(detail(text: "", present: true)))
        await model.loadIfNeeded()
        #expect(model.preview == .empty)
        #expect(model.preview != .notPulled)
        #expect(model.phase != .missing)
    }

    @Test("the four outcomes are four distinct answers, pairwise")
    func theFourOutcomesAreDistinct() async {
        var seen: [String] = []
        for answer in [
            Result<NoteDetail?, any Error>.failure(NoteUnreadable()),
            .success(nil),
            .success(detail(text: "", present: false)),
            .success(detail(text: "", present: true))
        ] {
            let (model, _) = makeModel(answer)
            await model.loadIfNeeded()
            seen.append(outcomeKey(model))
        }
        #expect(Set(seen).count == 4, "two of the four outcomes render the same way")
    }

    // MARK: The preview is a preview

    @Test("the body crosses verbatim — extract_text markers are text, not markdown")
    func theBodyIsNotParsed() async {
        // Exactly what §12.1.3 produces: a clamped heading marker, a bullet, a
        // numbered item that is always `1. `, and formatting that is already
        // gone. Nothing here may be interpreted.
        let text = "# Heading\n- a bullet\n1. an item\n**not bold**\n`not code`"
        let (model, _) = makeModel(.success(detail(text: text)))
        await model.loadIfNeeded()
        #expect(model.preview == .text(text))
    }

    @Test("text wins over present, so a body that arrived with text is never reported as absent")
    func textWinsOverPresent() {
        #expect(NoteBodyPreview.of(NoteBody(text: "words", present: false)) == .text("words"))
        #expect(NoteBodyPreview.of(NoteBody(text: "words", present: true)) == .text("words"))
        // And `present` decides only where there is nothing to show.
        #expect(NoteBodyPreview.of(NoteBody(text: "", present: false)) == .notPulled)
        #expect(NoteBodyPreview.of(NoteBody(text: "", present: true)) == .empty)
    }

    // MARK: Retry, titles, routes

    @Test("a failed read stays retryable, so the retry button is a real attempt")
    func aFailedReadIsRetried() async {
        let (model, reader) = makeModel(.failure(NoteUnreadable()))
        await model.loadIfNeeded()
        await model.loadIfNeeded()
        #expect(reader.callLog == ["read:n1", "read:n1"])
    }

    @Test("a note that read is read once, never once per render")
    func aSuccessfulReadHappensOnce() async {
        let (model, reader) = makeModel(.success(detail(text: "words")))
        await model.loadIfNeeded()
        await model.loadIfNeeded()
        _ = model.preview
        #expect(reader.callLog == ["read:n1"])
    }

    @Test("a missing note is not re-read on every render either")
    func aMissingNoteIsReadOnce() async {
        let (model, reader) = makeModel(.success(nil))
        await model.loadIfNeeded()
        await model.loadIfNeeded()
        #expect(reader.callLog == ["read:n1"])
    }

    @Test("an untitled note says so, in the same words the row does")
    func anUntitledNoteIsNamed() async {
        let (untitled, _) = makeModel(.success(detail(title: "", text: "words")))
        await untitled.loadIfNeeded()
        #expect(untitled.displayTitle == "Untitled note")

        let (named, _) = makeModel(.success(detail(title: "Quarterly", text: "words")))
        await named.loadIfNeeded()
        #expect(named.displayTitle == "Quarterly")
    }

    @Test("the route carries the id and nothing else, and survives a restored path")
    func aNoteRouteIsCodable() throws {
        let route = NoteRoute(id: "note-0123456789abcdef")
        let data = try JSONEncoder().encode(route)
        #expect(try JSONDecoder().decode(NoteRoute.self, from: data) == route)
    }

    @Test("the route's id is what is read, not something derived from a row")
    func theRouteIdIsWhatIsRead() async {
        let (model, reader) = makeModel(.success(detail()), id: "note-abc")
        await model.loadIfNeeded()
        #expect(reader.callLog == ["read:note-abc"])
    }
}

/// This screen's own sources, located from `#filePath`.
private enum NoteReadSources {
    static var readable: Bool {
        FileManager.default.fileExists(atPath: readView) &&
            FileManager.default.fileExists(atPath: notesList)
    }

    private static var featureRoot: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Memry/Features/Notes", isDirectory: true)
    }

    static var readView: String {
        featureRoot.appendingPathComponent("NoteReadView.swift").path
    }

    static var notesList: String {
        featureRoot.appendingPathComponent("NotesListView.swift").path
    }

    static func source(_ path: String) throws -> String {
        try String(contentsOfFile: path, encoding: .utf8)
    }

    /// The file with its `//` comment lines removed.
    ///
    /// The forbidden-API check below must fire on **code**, not on a file
    /// header that names the very APIs it is explaining it does not use — that
    /// is a test that punishes documentation and proves nothing.
    static func code(_ path: String) throws -> String {
        try source(path)
            .split(separator: "\n", omittingEmptySubsequences: false)
            .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }
            .joined(separator: "\n")
    }
}

/// The structural half: that the screen is reachable, and that it stayed a
/// preview.
@Suite("T157 note read source structure")
struct NoteReadSourceTests {
    @Test(
        "the note rows push a value route, so the one registration resolves them",
        .enabled(if: NoteReadSources.readable, "the checkout is not present on a device")
    )
    func theRowsPushAValueRoute() throws {
        let notesList = try NoteReadSources.source(NoteReadSources.notesList)
        #expect(notesList.contains("NavigationLink(value: NoteRoute(id: note.id))"))
        // The destination is built from the browse model's own reader, which
        // on the production graph is `CoreNotesReader`. A second reader minted
        // here would be a second path into the core with its own lifetime.
        #expect(notesList.contains("NoteReadView(route: route, reader: model.reader)"))
    }

    @Test(
        "the read screen parses no markdown and hosts no editor",
        .enabled(if: NoteReadSources.readable, "the checkout is not present on a device")
    )
    func theScreenStaysAPreview() throws {
        let source = try NoteReadSources.code(NoteReadSources.readView)
        // §12.1.2: a non-editor client "owns `extract_text` and nothing else".
        // Each of these is a way to stop being one.
        for forbidden in [
            "AttributedString(markdown",
            "markdown:",
            "WKWebView",
            "WebView",
            "EditorHost",
            "encodeState"
        ] {
            #expect(source.contains(forbidden) == false, "\(forbidden) in NoteReadView.swift")
        }
    }
}
