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
    /// the keys after it, with the keys pressed before the Return that the
    /// keyboard dropped (`PressedKeys`).
    var line: String
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

    /// The field showing `text` as one line: `line` with the keys typed
    /// since the Return in the Return's place, or `nil` as for `held`.
    func kept(in text: String) -> String? {
        guard let held = held(in: text) else { return nil }
        let tail = shown.firstIndex(of: "\n").map { shown.distance(from: $0, to: shown.endIndex) - 1 } ?? 0
        return String(line.dropLast(tail)) + held + String(line.suffix(tail))
    }
}

/// The hardware keys pressed in a one-line field that the keyboard has not
/// inserted, so that a Return keeps every key pressed before it (#4823,
/// #4815).
///
/// The keyboard inserts keys from a queue, well behind their presses, and a
/// Return's press can make it drop keys it still queues: one inside the run
/// (`title` stored as `Tite`), or the last ones when the Return is held as
/// long as a real keypress (`Tit`), sometimes after autocorrecting the part
/// of the word it saw (`To`). The field hears every press as the key goes
/// down, in press order, so the presses decide the line: each key pressed
/// before the Return went down belongs to it. Inserted text is matched to
/// the presses in order. A pressed key the text skipped goes back where it
/// was typed, and keys pressed before the Return that never arrived go after
/// the last one that did. Anything else the presses cannot explain (a
/// deletion, an autocorrection with no key missing, an input method, a
/// paste, a key with no text) stops the matching until the next press, and
/// nothing is put back.
struct PressedKeys {
    /// Keys pressed and not inserted yet, in press order, with whether a
    /// Return went down after them.
    private var queued: [(key: Character, beforeReturn: Bool)] = []
    /// Keys the keyboard skipped, at their offset in the field's text.
    private var skipped: [(offset: Int, key: Character)] = []
    /// The offset after the last key inserted, where the keys still queued
    /// land.
    private var caret: Int?
    /// The text as the keyboard rewrote it while keys pressed before the
    /// Return were still queued, with the skipped keys put back, and its
    /// caret. The rewrite saw part of a word, so the presses hold the line
    /// from here on.
    private var rewritten: (text: String, caret: Int)?

    /// A key that types `characters` went down. A key with no text of its
    /// own (an arrow, Backspace, Tab, Escape) is an edit the presses cannot
    /// follow.
    mutating func pressed(_ characters: String) {
        guard characters.count == 1, let key = characters.first,
              key.unicodeScalars.allSatisfy({ ![.control, .privateUse].contains($0.properties.generalCategory) })
        else { return reset() }
        queued.append((key, false))
    }

    /// A Return went down: the keys queued so far belong to its line.
    mutating func returnPressed() {
        queued = queued.map { ($0.key, true) }
    }

    /// The field's text went from `previous` to `value`.
    mutating func changed(from previous: String, to value: String) {
        guard rewritten == nil else { return }
        let old = Array(previous)
        let new = Array(value)
        guard old != new else { return }
        var prefix = 0
        while prefix < old.count, prefix < new.count, old[prefix] == new[prefix] { prefix += 1 }
        var suffix = 0
        while suffix < old.count - prefix, suffix < new.count - prefix,
              old[old.count - 1 - suffix] == new[new.count - 1 - suffix] { suffix += 1 }
        // Only keys inserted at one place, as the keyboard inserts them.
        guard prefix + suffix == old.count else {
            // An autocorrection that the key it inserts last triggered, as
            // Space does.
            if let trigger = new[..<(new.count - suffix)].last, let first = queued.first,
               first.key.lowercased() == trigger.lowercased(), skipped.allSatisfy({ $0.offset <= prefix }) {
                queued.removeFirst()
                caret = new.count - suffix
                return
            }
            if let caret, queued.contains(where: \.beforeReturn) {
                rewritten = (restored(previous), caret + skipped.count)
                return
            }
            return reset()
        }
        for (index, key) in new[prefix ..< new.count - suffix].enumerated() {
            let offset = prefix + index
            // The Return's own newline is no pressed key.
            if key == "\n" { continue }
            // Autocapitalization changes the case of a pressed key.
            guard let match = queued.firstIndex(where: { $0.key.lowercased() == key.lowercased() }),
                  queued[..<match].allSatisfy(\.beforeReturn)
            else { return reset() }
            skipped += queued[..<match].map { (offset, $0.key) }
            queued.removeFirst(match + 1)
            caret = offset + 1
        }
    }

    /// `text`, the field's text as a Return ends the line, with the keys
    /// pressed before the Return that it lacks. The keys still queued go
    /// after the last key inserted, or at `end` when none was.
    func restoring(_ text: String, end: Int) -> String {
        let base = rewritten?.text ?? restored(text)
        var chars = Array(base)
        let at = rewritten?.caret ?? caret.map { $0 + skipped.count } ?? end
        guard at <= chars.count else { return base }
        chars.insert(contentsOf: queued.prefix { $0.beforeReturn }.map(\.key), at: at)
        return String(chars)
    }

    /// `text` with the skipped keys back in their places.
    private func restored(_ text: String) -> String {
        var chars = Array(text)
        for (shift, entry) in skipped.enumerated() {
            guard entry.offset + shift <= chars.count else { return text }
            chars.insert(entry.key, at: entry.offset + shift)
        }
        return String(chars)
    }

    mutating func reset() {
        queued = []
        skipped = []
        caret = nil
        rewritten = nil
    }
}
