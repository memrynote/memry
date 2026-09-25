import Foundation
import MemryCore
import Observation

// The note read screen's value types and the view model's derived reads, split from `NoteRead.swift` so the stored state and its writes stay in one file.

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

extension NoteReadViewModel {
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

    /// Where an on-demand body fetch is. `.idle` covers both "not asked" and
    /// "asked, and it worked" — the second is visible as a body rather than as
    /// a state.
    enum Fetch: Equatable {
        case idle
        case fetching
        /// The pull stopped at an update this device could not open (chapter
        /// 07 §7.9). The body is **incomplete, not absent**, and the cursor
        /// did not advance, so a later fetch resumes there.
        case incomplete
        /// The fetch threw. Whether it is worth repeating is the mapped
        /// error's business, not this screen's.
        case failed(UserFacingError)
    }

    /// Every distinct `url` an attachment-bearing block carries.
    ///
    /// `taskBlock` and the link cards are deliberately absent: a bookmark's
    /// url is a web address rather than a vault path, and resolving it would
    /// ask the core about something it correctly refuses.
    static func attachmentUrls(in blocks: [Block]) -> [String] {
        let kinds: Set<String> = ["image", "inlineImage", "file", "audio", "video"]
        var seen: [String] = []
        for block in blocks where kinds.contains(block.kind) {
            guard let url = block.props.first(where: { $0.name == "url" })?.value,
                  !url.isEmpty,
                  !seen.contains(url)
            else { continue }
            seen.append(url)
        }
        // A table cell's inline image is a run, not a block: its address is
        // the node's `src`. Without this it was never bound and drew a
        // placeholder forever.
        for block in blocks {
            for run in block.inline where run.marks.contains("inlineImage") {
                guard let src = run.markAttrs["inlineImage.src"] ?? run.target,
                      !src.isEmpty,
                      !seen.contains(src)
                else { continue }
                seen.append(src)
            }
        }
        return seen
    }

    /// Where a `[[wiki link]]` leads, or `nil` when it names neither a note
    /// nor a day.
    ///
    /// The lookup happens on the tap rather than on load: a note can hold many
    /// links, and resolving all of them to draw one screen would be a lookup
    /// per link for an answer most of them are never asked for.
    ///
    /// A note wins; a title naming no note that spells a day (`YYYY-MM-DD` or
    /// `jYYYY-MM-DD`) comes back as the day's `j<date>` route, which the page
    /// opens in the Journal tab (JP052, `JournalLink`).
    func wikiTarget(for title: String) async -> NoteRoute? {
        do {
            if let id = try await reader.resolveWikiTarget(title) { return NoteRoute(id: id) }
        } catch {
            let mapped = ErrorMapping.userFacing(error)
            Log.storage.error("a wiki link could not be resolved", .code(mapped.code))
            return nil
        }
        return JournalLink.date(fromWikiTarget: title).map(JournalLink.route(forDay:))
    }

    /// The body, or `nil` in every phase that has no note.
    var preview: NoteBodyPreview? {
        guard case let .ready(detail) = phase else { return nil }
        return NoteBodyPreview.of(detail.body)
    }

    /// Whether a wiki link's title names a note in this vault, or `nil` while
    /// the list is unread — which draws every link as whole rather than
    /// calling a good one broken. Titles only: a link naming a note by its
    /// alias reads as broken here and still resolves on the tap. A date title
    /// always leads somewhere, its journal day (JP052), so it reads as whole.
    var titleExists: ((String) -> Bool)? {
        guard !vaultNotes.isEmpty else { return nil }
        let titles = vaultTitles
        return { titles.contains($0.lowercased()) || JournalLink.date(fromWikiTarget: $0) != nil }
    }

    /// The note's text for an export (N802).
    ///
    /// `extract_text` output, which is all §12.1.2 gives a non-editor client.
    var exportText: String {
        guard case let .ready(detail) = phase else { return "" }
        return detail.body.text
    }

    /// The note's folder, or `nil` at the vault root.
    ///
    /// `nil` is the root rather than "unknown": the read has answered by the
    /// time anything asks, and §13.4's explicit null is what the payload
    /// carries for a note that sits at the top.
    var folderPath: String? {
        guard case let .ready(detail) = phase else { return nil }
        return detail.summary.folderPath
    }

    var displayTitle: String {
        guard case let .ready(detail) = phase, !detail.summary.title.isEmpty else {
            return "Untitled note"
        }
        return detail.summary.title
    }
}
