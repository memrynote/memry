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
//  "Untitled note". The app cannot turn the mirror off, so the title, which
//  owns the new note's first caret, takes every such move back until the
//  user moves the caret.
//

import Foundation

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
}

/// A new note's title wants the caret until the user moves it.
struct TitleFocusClaim {
    private(set) var holds = false

    mutating func start() { holds = true }
    mutating func end() { holds = false }

    /// Whether the title takes the caret back after `move`. Only the list's
    /// own moves are taken back. One the user made ends the claim, and the
    /// title focusing again or the keyboard going away leaves it as it is.
    mutating func takesBack(after move: TitleFocusMove) -> Bool {
        guard holds else { return false }
        switch move {
        case .toSelectedRow: return true
        case .intoTitle, .toNothing: return false
        case .byKey, .intoText, .elsewhere:
            holds = false
            return false
        }
    }
}
