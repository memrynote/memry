import Foundation

// JP052. The day a link names, for the surfaces outside the Journal tab that
// open a day (a wiki link, a journal backlink, a related item on a task).
// Desktop titles a journal with its date (`journal-handler.ts:72`) and reads
// the `j<date>` id form with `dateFromJournalId` (`journal-api.ts:348-351`);
// the core's `resolve_wiki_target_kind` accepts the same two spellings.

enum JournalLink {
    /// The day a `[[wiki link]]` target names: `YYYY-MM-DD` or the
    /// `jYYYY-MM-DD` id form, trimmed. `nil` when it names no real day.
    static func date(fromWikiTarget target: String) -> String? {
        let wanted = target.trimmingCharacters(in: .whitespacesAndNewlines)
        if JournalDates.date(wanted) != nil { return wanted }
        return date(fromJournalId: wanted)
    }

    /// Desktop's `dateFromJournalId`: `j` then a real `YYYY-MM-DD`.
    static func date(fromJournalId id: String) -> String? {
        guard id.hasPrefix("j") else { return nil }
        let date = String(id.dropFirst())
        return JournalDates.date(date) == nil ? nil : date
    }

    /// The route a day travels under through a note page's `open` closure:
    /// its minted `j<date>` id, which the page hands to the Journal tab
    /// rather than pushing as a note.
    static func route(forDay date: String) -> NoteRoute {
        NoteRoute(id: "j\(date)")
    }
}
