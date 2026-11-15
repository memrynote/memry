//
//  LineReturn.swift
//  #4705: keys typed right after Return in a one-line field (a note's
//  title, a journal day's first line) are not lost.
//
//  Return saves the field's line, and keys typed after it before the page
//  moves on (a fast typist, a text expander, a hardware burst) still land
//  in the field. Seen a render later, the newline was no longer last and
//  became a space, or the stored text was drawn over the keys (DATA-LOSS).
//  The field now splits its text on the keystroke that brings the Return
//  and holds the keys after it: the title hands them to the body block as
//  it takes the caret (`EditorSession.takeCaret`), the journal writes them
//  as the next paragraph.
//

import Foundation

/// A Return typed in a one-line field, until the keys after it move on. The
/// field shows `shown` with the keys typed since inserted at the caret.
struct LineReturn: Equatable {
    /// The line the Return saves: the field's text without the Return and
    /// the keys after it.
    let line: String
    /// The field's text once Return was pressed, without the keys after it.
    let shown: String

    /// A Return the field took as a submit: it shows `text`.
    init(submitted text: String) {
        line = text
        shown = text
    }

    /// The Return in the edit that turned `previous` into `value`, or `nil`
    /// when the inserted text holds no newline. Keys inserted before the
    /// newline belong to the line, the ones after it are held.
    init?(previous: String, value: String) {
        let old = Array(previous)
        let new = Array(value)
        var prefix = 0
        while prefix < old.count, prefix < new.count, old[prefix] == new[prefix] { prefix += 1 }
        var suffix = 0
        while suffix < old.count - prefix, suffix < new.count - prefix,
              old[old.count - 1 - suffix] == new[new.count - 1 - suffix] { suffix += 1 }
        let inserted = new[prefix ..< new.count - suffix]
        guard let newline = inserted.firstIndex(of: "\n") else { return nil }
        let before = String(new[...newline])
        let tail = String(new[(new.count - suffix)...])
        shown = before + tail
        line = shown.replacingOccurrences(of: "\n", with: "")
    }

    /// The keys typed since the Return in the field showing `text`, or `nil`
    /// when an edit did more than insert them (a Backspace past the Return).
    func held(in text: String) -> String? {
        let chars = Array(text)
        let shown = Array(shown)
        guard chars.count >= shown.count else { return nil }
        var prefix = 0
        while prefix < shown.count, chars[prefix] == shown[prefix] { prefix += 1 }
        let rest = shown.count - prefix
        guard chars.suffix(rest).elementsEqual(shown.suffix(rest)) else { return nil }
        return String(chars[prefix ..< chars.count - rest])
    }
}
