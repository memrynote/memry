import Foundation
import MemryCore
import Observation

// T157, the state half. One note, read-only.
//
// **This is a preview, not a render, and it is the placeholder T176 replaces**
// (spec-defect 125, Kaan's decision). `NoteBody.text` is `extract_text` output
// — chapter 12 §12.1's *only* text operation — so a heading arrives as `# `, a
// bullet as `- `, and bold, links and code fences arrive as nothing at all.
// Nothing here parses or serialises markdown, because §12.1.2 forbids a
// non-editor client from doing either: it "owns `extract_text` and nothing
// else". A faithful render needs `Document::encode_state()` exported **and**
// the editor bundle hosted through `EditorHost`, and per spec-defect 107 the
// core can be handed neither today.
//
// **Four outcomes, four screens, and no arm shared between them.** This is the
// single most likely bug in this task, so the distinction is carried by types
// rather than by care:
//
//   * `read` **threw** — the note may exist and may hold anything. `.unreadable`.
//   * `read` returned **nil** — this vault holds no live note by that id.
//     `.missing`. A restored navigation path lands here, and so does a note
//     deleted on another device.
//   * the body is **not on this device** — `present == false`. `.notPulled`.
//   * the body is **empty** — `present == true`, no text. `.empty`.
//
// The first two are `Phase` cases; the last two are ``NoteBodyPreview`` cases,
// because they are facts about a note that was read successfully and so must
// still show its title and its dates. Collapsing any pair would report an
// unread note as an empty one, which is the failure `domain/reads.rs` says the
// whole module was written against.
//
// **The call blocks.** `Notes.read(id:)` is a local SQLite read plus a `yrs`
// apply (`contracts/core-api.md`, the read slice), so it goes on the shell's
// serial `CoreExecutor` and is never awaited directly — and it offers no
// Cancel, because a blocking call has nothing to cancel (spec-defect 108).
//
// **No title, id, folder path or body text reaches a log** (Constitution II).
// `Log` takes a `StaticString` and a closed `LogDetail`; a count and an error
// code are the only things that can be said about a note here.

/// Where a note route in the browse stack points.
///
/// The **id and nothing else**. `Codable` because `NavigationStack` restores a
/// saved path, and a restored path must resolve without the row that produced
/// it ever having existed — which is the case research R15's
/// `navigationDestination` rule is about. Carrying the title here would make a
/// restored route render a title the vault may no longer agree with.
struct NoteRoute: Hashable, Codable, Sendable {
    let id: String
}

/// What the body of a successfully read note actually is.
///
/// Three cases, and `NoteBody`'s own doc comment is the reason: "`false` with
/// an empty `text` is *the body has not been pulled here*; `true` with an empty
/// `text` is *the user left this note empty*."
enum NoteBodyPreview: Equatable, Sendable {
    /// `extract_text` output, non-empty. Plain text, with `#` and `- ` markers
    /// that are a preview convention and not markdown (§12.1.3).
    case text(String)
    /// The note exists here; its body does not. Nothing is missing from the
    /// note — the body has simply never been pulled onto this device.
    case notPulled
    /// The note exists here, its body is present, and the user left it empty.
    case empty

    /// `present` decides only where there is no text to show, which is exactly
    /// the distinction the core draws. Text always wins: a body that arrived
    /// with text is text, whatever else is true of it.
    static func of(_ body: NoteBody) -> NoteBodyPreview {
        if !body.text.isEmpty { return .text(body.text) }
        return body.present ? .empty : .notPulled
    }
}

@MainActor
@Observable
final class NoteReadViewModel {
    /// Where the screen is. `.missing` and `.unreadable` are deliberately not
    /// one case: "this vault has no such note" is a fact, and "this note would
    /// not read" is a failure, and only the second is worth retrying.
    enum Phase: Equatable {
        case loading
        /// `read` returned a note. Its body is a ``NoteBodyPreview``.
        case ready(NoteDetail)
        /// `read` returned `nil`. **Never rendered as an empty note.**
        case missing
        /// `read` threw. **Never rendered as a missing or an empty note.**
        case unreadable(UserFacingError)
    }

    let route: NoteRoute

    /// The reader in use. Internal so the wiring suite can assert the
    /// production graph holds the **core** reader rather than something that
    /// behaves like it — Phase 3 shipped five tiers that were fully tested
    /// behind fakes and never called once.
    let reader: any NotesReading

    private(set) var phase: Phase = .loading
    private var hasLoaded = false

    init(route: NoteRoute, reader: any NotesReading) {
        self.route = route
        self.reader = reader
    }

    /// The body, or `nil` in every phase that has no note.
    var preview: NoteBodyPreview? {
        guard case let .ready(detail) = phase else { return nil }
        return NoteBodyPreview.of(detail.body)
    }

    /// The row's placeholder, matched exactly. An id identifies content and
    /// reads as noise, so an untitled note says so in words on both screens.
    var displayTitle: String {
        guard case let .ready(detail) = phase, !detail.summary.title.isEmpty else {
            return "Untitled note"
        }
        return detail.summary.title
    }

    /// Loads once per screen. `.task` fires again whenever the view is
    /// re-identified, and re-reading a body costs an FFI crossing and a CRDT
    /// apply for an answer the screen already holds.
    func loadIfNeeded() async {
        guard !hasLoaded else { return }
        await load()
    }

    /// What the retry button calls.
    func reload() async {
        await load()
    }

    private func load() async {
        hasLoaded = true
        phase = .loading
        let detail: NoteDetail?
        do {
            detail = try await reader.read(id: route.id)
        } catch {
            let mapped = ErrorMapping.userFacing(error)
            Log.storage.error("this note could not be read", .code(mapped.code))
            // Retryable, so the next attempt is a real attempt.
            hasLoaded = false
            // **Not** `.missing`. The note may be here and may hold anything.
            phase = .unreadable(mapped)
            return
        }
        guard let detail else {
            Log.storage.info("a note route resolved to no note")
            phase = .missing
            return
        }
        // No detail at all. A character count is not text, but it is a
        // measurement of one, and `LogDetail` has no shape that says "the body
        // was present" without also saying how long it is.
        Log.storage.info("read one note")
        phase = .ready(detail)
    }
}
