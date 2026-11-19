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
    /// since the Return in the Return's place, but the first `dropping`, or
    /// `nil` as for `held`.
    func kept(in text: String, dropping: Int = 0) -> String? {
        guard let held = held(in: text)?.dropFirst(dropping) else { return nil }
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
    /// Return were still queued, with the skipped keys put back and the
    /// keys inserted at its caret since, and that caret. The rewrite saw
    /// part of a word, so the presses hold the line from here on.
    private var rewritten: (text: String, caret: Int)?
    /// The keys the last Return's line put back, while they may still
    /// arrive, and how many arrived in the field since that Return.
    private var late = LateKeys()
    private var lateArrived = 0
    /// The keyboard's language, which decides a key's case: `i` is `İ` in
    /// Turkish.
    var locale = Locale.current

    /// A key that types `characters` went down. A key with no text of its
    /// own (an arrow, Backspace, Tab, Escape) is an edit the presses cannot
    /// follow.
    mutating func pressed(_ characters: String) {
        guard let key = LateKeys.key(characters) else { return reset() }
        queued.append((key, false))
        late.pressed(characters)
    }

    /// A Return went down: the keys queued so far belong to its line.
    mutating func returnPressed() {
        queued = queued.map { ($0.key, true) }
    }

    /// The field's text went from `previous` to `value`.
    mutating func changed(from previous: String, to value: String) {
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
            late = LateKeys()
            guard rewritten == nil else { return }
            // An autocorrection that the key it inserts last triggered, as
            // Space does.
            if let trigger = new[..<(new.count - suffix)].last, let first = queued.first,
               same(first.key, trigger), skipped.allSatisfy({ $0.offset <= prefix }) {
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
        var inserted = new[prefix ..< new.count - suffix]
        // Keys the last Return's line put back, delivered after all.
        while let key = inserted.first, late.arrived(key) {
            inserted = inserted.dropFirst()
            lateArrived += 1
        }
        if let rewritten { return insert(inserted, into: rewritten, tail: suffix) }
        for (index, key) in zip(inserted.indices, inserted) {
            // The Return's own newline is no pressed key.
            if key == "\n" { continue }
            // Autocapitalization changes the case of a pressed key.
            guard let match = queued.firstIndex(where: { same($0.key, key) }),
                  queued[..<match].allSatisfy(\.beforeReturn)
            else { return reset() }
            skipped += queued[..<match].map { (index, $0.key) }
            queued.removeFirst(match + 1)
            caret = index + 1
        }
    }

    /// Keys inserted after a rewrite go into it when they land at its caret,
    /// after the keys pressed before them.
    private mutating func insert(_ keys: ArraySlice<Character>, into rewritten: (text: String, caret: Int), tail: Int) {
        var chars = Array(rewritten.text)
        var at = rewritten.caret
        guard tail == chars.count - at else { return }
        for key in keys where key != "\n" {
            var typed = [key]
            if let match = queued.firstIndex(where: { same($0.key, key) }), queued[..<match].allSatisfy(\.beforeReturn) {
                typed = queued[..<match].map(\.key) + typed
                queued.removeFirst(match + 1)
            }
            chars.insert(contentsOf: typed, at: at)
            at += typed.count
        }
        self.rewritten = (String(chars), at)
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

    /// The line went to its Return: the keys `restoring` put back in it may
    /// still arrive, ahead of the keys pressed since.
    mutating func handOff() {
        let back = queued.prefix(while: \.beforeReturn).map(\.key)
        let since = queued.dropFirst(back.count).map(\.key)
        reset()
        late = LateKeys(keys: back, presses: since, locale: locale)
        lateArrived = 0
    }

    /// How many of the keys the last Return's line put back arrived in the
    /// field since, and the ones that may still arrive, wherever the caret
    /// goes. The field stops waiting for them.
    mutating func takeLate() -> (arrived: Int, late: LateKeys?) {
        defer {
            late = LateKeys()
            lateArrived = 0
        }
        return (lateArrived, late.waiting ? late : nil)
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

    private func same(_ a: Character, _ b: Character) -> Bool {
        LateKeys.same(a, b, in: locale)
    }

    mutating func reset() {
        queued = []
        skipped = []
        caret = nil
        rewritten = nil
        late = LateKeys()
    }
}

/// Keys a Return's line put back that the keyboard had not inserted
/// (`PressedKeys`). Had it only delayed them, they arrive after the Return,
/// in press order and ahead of every key pressed since: in the field while
/// it holds the keys after the Return, or in the block that took the caret.
/// Such a key is dropped there, so the note does not get it twice. A key
/// pressed since the Return can be the same key: one that arrives while a
/// press of it is pending is kept, as a key typed twice is visible and a
/// key lost is not.
struct LateKeys {
    private var keys: [Character] = []
    /// Keys pressed since the Return.
    private var presses: [Character] = []
    private var locale = Locale.current

    init() {}

    init(keys: [Character], presses: [Character], locale: Locale) {
        self.keys = keys
        self.presses = presses
        self.locale = locale
    }

    /// Whether a key may still arrive.
    var waiting: Bool { !keys.isEmpty }

    /// A key that types `characters` went down. A key with no text of its
    /// own is an edit the keys cannot follow: none of them is awaited after
    /// it.
    mutating func pressed(_ characters: String) {
        guard waiting, !characters.isEmpty else { return }
        guard let key = Self.key(characters) else { return keys = [] }
        presses.append(key)
    }

    /// `key` was inserted: whether it is the next of the keys put back. Any
    /// other key ends the wait, as they would have arrived before it.
    mutating func arrived(_ key: Character) -> Bool {
        guard let next = keys.first else { return false }
        guard Self.same(next, key, in: locale), !presses.contains(where: { Self.same($0, key, in: locale) }) else {
            keys = []
            return false
        }
        keys.removeFirst()
        return true
    }

    /// The text key typing `characters`, or `nil` for a key with no text of
    /// its own.
    static func key(_ characters: String) -> Character? {
        guard characters.count == 1, let key = characters.first,
              key.unicodeScalars.allSatisfy({ ![.control, .privateUse].contains($0.properties.generalCategory) })
        else { return nil }
        return key
    }

    /// Whether `a` and `b` are one key in either case: autocapitalization
    /// changes the case of a pressed key, by the keyboard's language.
    static func same(_ a: Character, _ b: Character, in locale: Locale) -> Bool {
        String(a).compare(String(b), options: .caseInsensitive, locale: locale) == .orderedSame
    }
}
