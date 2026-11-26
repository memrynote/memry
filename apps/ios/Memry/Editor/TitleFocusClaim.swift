//
//  TitleFocusClaim.swift
//  #4774, #4824: a new note's title keeps the caret the notes list takes
//  from it.
//
//  In the iPad split view, the notes list is a SwiftUI `List` whose
//  selection is the open note. Each time it mirrors that selection into its
//  collection view (`selectItemAtIndexPath:`, when the row's cell is made and
//  when the list's contents update), UIKit requests a focus update to the
//  list, and with a hardware keyboard the focus moves to the selected row.
//  After New note that happens twice or more, a few hundred milliseconds
//  apart, and the keys typed next went to the list: the note stayed
//  "Untitled note". While the claim holds, the list's selection does not
//  follow focus (`NotesListFocusHold`, #5100), so the mirror moves nothing:
//  keys typed while the row held the focus were lost. The title, which owns
//  the new note's first caret, still takes back any move to the selected
//  row until the user moves the caret.
//
//  Invariant: the claim only ever returns the caret to the title while the
//  user has made no move of their own, and a take-back never ends the edit.
//  The focus the list takes and the title takes back is one edit: no save,
//  no restart from the stored title, no reset of the keys pressed so far.
//

import Foundation

/// What a focus update moved the keyboard focus to, as UIKit names it.
enum TitleFocusTarget: Equatable {
    case nothing
    /// The title's own text view, whichever one the page drew.
    case title
    /// Another text field, such as a body block.
    case text
    /// A selected collection view cell, such as the list's row.
    case selectedRow
    /// Anything else, such as a menu or a control.
    case other
}

/// Where a focus update took the keyboard focus from a note's title.
enum TitleFocusMove: Equatable {
    /// A key moved it (Tab, an arrow): the update has a heading.
    case byKey
    /// Into the title's own text view, as when its page draws again.
    case intoTitle
    /// Into another text field, such as the body after a Return.
    case intoText
    /// To the list's selected row, with no key pressed.
    case toSelectedRow
    /// To nothing: the keyboard was dismissed.
    case toNothing
    /// Anything else, such as a menu or a control.
    case elsewhere

    /// The move to `next`, made by a key when the update has a heading.
    init(to next: TitleFocusTarget, byKey: Bool) {
        switch next {
        case .nothing: self = .toNothing
        case _ where byKey: self = .byKey
        case .title: self = .intoTitle
        case .text: self = .intoText
        case .selectedRow: self = .toSelectedRow
        case .other: self = .elsewhere
        }
    }
}

/// A new note's title wants the caret until the user moves it.
struct TitleFocusClaim {
    private(set) var holds = false
    /// The title lost the caret to a move it takes back. Its focus loss is
    /// not the end of the edit.
    private(set) var retaking = false

    mutating func start() { holds = true }

    mutating func end() {
        holds = false
        retaking = false
    }

    /// Whether the title takes the caret back after `move` from it. Only the
    /// list's own moves are taken back. One the user made ends the claim,
    /// and the title focusing again or the keyboard going away keeps it.
    mutating func takesBack(after move: TitleFocusMove) -> Bool {
        guard holds else { return false }
        switch move {
        case .toSelectedRow:
            retaking = true
            return true
        case .intoTitle:
            // The title has the caret again.
            retaking = false
            return false
        case .toNothing:
            return false
        case .byKey, .intoText, .elsewhere:
            end()
            return false
        }
    }

    /// A focus move that did not start in the title. The list's mirror only
    /// ever moves the focus to its selected row with no key pressed (#5100),
    /// so any other move the user made: one by a key (Tab, an arrow, into
    /// the list too), or into a text view or a control. It ends the claim,
    /// and the list's selection follows focus again.
    mutating func observed(_ move: TitleFocusMove) {
        switch move {
        case .byKey, .intoText, .elsewhere: end()
        case .intoTitle, .toSelectedRow, .toNothing: break
        }
    }

    /// Whether the title takes the caret now, as the take-back runs. Not
    /// once the claim ended, nor from a text view the user put the caret in
    /// meanwhile: that move is theirs, and it ends the claim.
    mutating func retakes(caretInOtherText: Bool) -> Bool {
        guard retaking else { return false }
        guard holds, !caretInOtherText else {
            end()
            return false
        }
        return true
    }

    /// The title has the caret again. Whether it came back by a take-back,
    /// in which case the edit goes on as it was.
    mutating func refocused() -> Bool {
        defer { retaking = false }
        return retaking
    }
}
