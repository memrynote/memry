import SwiftUI
import UIKit

// #4377. The detail column's panes at regular width: the main pane, and a
// second note beside it (`NotesSplitRouter`).

enum NotesPaneSlot: String, CaseIterable, Sendable {
    case main, side
}

/// One pane of the detail column: the note it opened on, and the notes
/// followed from it.
struct NotesPane: Codable, Equatable, Sendable {
    var note: NoteRoute?
    var trail: [NoteRoute] = []

    init(note: NoteRoute? = nil, trail: [NoteRoute] = []) {
        self.note = note
        self.trail = trail
    }

    /// Each key optional on decode, as `Saved`'s are.
    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        note = try container.decodeIfPresent(NoteRoute.self, forKey: .note)
        trail = try container.decodeIfPresent([NoteRoute].self, forKey: .trail) ?? []
    }

    var current: NoteRoute? { trail.last ?? note }
}

/// The pane a note page is drawn in, for the opens that go beside it.
/// Equatable on the router and the slot, so the page's environment holds
/// still while it is typed in.
struct NotesPaneContext: Equatable {
    let router: NotesSplitRouter
    let slot: NotesPaneSlot

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.router === rhs.router && lhs.slot == rhs.slot
    }

    /// While both panes show, each page draws Back and its page menu in a
    /// header over its own pane (`NotesPaneHeader`): in the column's one
    /// navigation bar they would sit over the other pane (#4699).
    @MainActor var headed: Bool { router.splitShown }

    /// "Open to the Side", where the width holds two panes; `nil` elsewhere,
    /// so no control offers a pane that cannot show.
    @MainActor var openToTheSide: ((NoteRoute) -> Void)? {
        guard router.splitFits else { return nil }
        return { [router, slot] in router.openToTheSide($0, from: slot) }
    }
}

extension EnvironmentValues {
    @Entry var notesPane: NotesPaneContext?
}

/// Desktop's names (`notes.json` › `wikiLinkMenu`, `tree.actions`).
enum NotesPaneCopy {
    static let open = "Open"
    static let openToTheSide = "Open to the Side"
    static let resize = "Resize panes"
    static let pickerTitle = "Open a note"
    static let pickerPrompt = "Search notes"

    static func pane(_ slot: NotesPaneSlot) -> String {
        switch slot {
        case .main: "Main pane"
        case .side: "Side pane"
        }
    }
}

/// Reports each touch as it lands, with the keys held (`⌘`-click), then
/// fails at once, so every gesture under it (a caret, a scroll, a button)
/// runs as before.
struct TouchDown: UIGestureRecognizerRepresentable {
    let touched: (UIKeyModifierFlags) -> Void

    func makeUIGestureRecognizer(context: Context) -> Recognizer {
        let recognizer = Recognizer()
        recognizer.cancelsTouchesInView = false
        recognizer.delaysTouchesEnded = false
        recognizer.touched = touched
        return recognizer
    }

    func updateUIGestureRecognizer(_ recognizer: Recognizer, context: Context) {
        recognizer.touched = touched
    }

    final class Recognizer: UIGestureRecognizer {
        var touched: ((UIKeyModifierFlags) -> Void)?

        override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
            touched?(event.modifierFlags)
            state = .failed
        }
    }
}
