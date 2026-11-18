//
//  NewNoteKeys.swift
//  #4787: keys typed right after ⌘N go into the new note's title.
//
//  ⌘N writes the new note through the core, and its page draws on a later
//  turn, so the caret stays in the open note's body meanwhile. A typist
//  keeps going, and those keys landed in the note they had left, or went
//  nowhere once that page left the window (iPad HID at high load: 30 of 30
//  runs lost them, 5 into the old note). From ⌘N on, a hidden text view
//  holds the keys. The body resigns as it would for any other field, so its
//  own typing commits. The hold starts in the ⌘N command itself
//  (`NotesLinks.requestNewNote`): the Notes page takes the request on a
//  later SwiftUI update, and keys already queued reached the old note
//  before it (iPad HID: 2 of 30 runs, and the old title on a relaunch).
//
//  Invariant: the new note's title editor is the one owner of the keys held
//  for it. The hold never types them into a text input, whichever one takes
//  the caret from the holder (the title, the search palette, another note).
//  The title editor reads them outside its field's own edit callbacks,
//  where SwiftUI would draw its stale text over them: as it appears, before
//  its field takes the caret (the hold is drained then and keeps holding
//  until the field has the caret), and as its edit begins (whatever the
//  holder took meanwhile, `NewNoteSeeds`). A Return among them ends the
//  title there and the rest goes to the body, as a Return typed in the
//  title does. Nothing outside the page writes the title while the page is
//  on screen: the store hands a mounted title its seed and writes a seed as
//  the stored title only for a note whose page is not on screen, as the
//  page leaves or as the app goes to the background. A failed create
//  discards the keys with a log line next to the failure's alert.
//

import UIKit

/// One ⌘N's keys, held until the core makes its note and its title takes
/// the caret.
@MainActor
final class NewNoteKeys {
    private var holder: KeyHolder?
    private let seeds: NewNoteSeeds
    private var keep: NewNoteSeeds.Keep?
    private let log: Log
    /// The new note, once the core holds it.
    fileprivate private(set) var noteId: String?
    /// The keys of a hold that ended before the core made the note.
    private var waiting = ""

    /// ⌘N: holds the keys typed from now on in `window`.
    init(window: UIWindow?, seeds: NewNoteSeeds = .shared, log: Log = .interface) {
        self.seeds = seeds
        self.log = log
        guard let window else { return }
        let holder = KeyHolder(frame: CGRect(x: 0, y: 0, width: 1, height: 1))
        window.addSubview(holder)
        guard holder.becomeFirstResponder() else {
            holder.removeFromSuperview()
            log.error("the keys typed after a new note could not be held")
            return
        }
        holder.hold = self
        self.holder = holder
        seeds.holding(self)
    }

    /// The core made the note the keys are held for. `keep` writes a seed no
    /// title editor took as the note's title.
    func made(_ noteId: String, keep: @escaping NewNoteSeeds.Keep) {
        self.noteId = noteId
        self.keep = keep
        let keys = waiting
        waiting = ""
        seed(keys)
    }

    /// The core made no note: its alert is on screen, and the keys go.
    func failed() {
        let keys = waiting + (holder?.text ?? "")
        waiting = ""
        finish()
        if !keys.isEmpty {
            log.error("the keys typed after a new note were discarded: it was not created", .count(keys.count))
        }
    }

    /// The keys held so far, for the note's title as it appears. The holder
    /// keeps the caret until the title's field takes it.
    fileprivate func drain() -> String {
        let keys = holder?.text ?? ""
        holder?.text = ""
        return keys
    }

    /// The holder let go of the caret, or the app left: the keys wait for
    /// the note's title.
    fileprivate func end() {
        guard let holder else { return }
        let keys = holder.text ?? ""
        finish()
        if noteId == nil { waiting += keys } else { seed(keys) }
    }

    private func seed(_ keys: String) {
        guard let noteId, let keep, !keys.isEmpty else { return }
        seeds.put(keys, for: noteId, keep: keep)
        // The note was made after the app left: no title editor will run.
        if UIApplication.shared.applicationState == .background { seeds.flush() }
    }

    private func finish() {
        holder?.hold = nil
        holder?.removeFromSuperview()
        holder = nil
    }
}

/// The keys held after ⌘N, by note, until the note's title editor takes
/// them (`NoteTitleEditor`).
@MainActor
final class NewNoteSeeds {
    /// Writes `title` as `noteId`'s stored title.
    typealias Keep = @MainActor (_ noteId: String, _ title: String) -> Void
    /// A mounted title editor takes `keys` into its edit and saves it.
    typealias Absorb = @MainActor (_ keys: String) -> Void

    static let shared = NewNoteSeeds()

    private var seeds: [String: (keys: String, keep: Keep)] = [:]
    private let holds = NSHashTable<NewNoteKeys>.weakObjects()
    /// The title editors on screen, by note: a redrawn page's title appears
    /// before the old one leaves, and the latest takes the keys.
    private var titles: [String: (count: Int, absorb: Absorb)] = [:]

    init() {
        NotificationCenter.default.addObserver(
            forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: nil
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.flush() }
        }
    }

    fileprivate func holding(_ hold: NewNoteKeys) {
        holds.add(hold)
    }

    /// Tabs become spaces: a title holds none.
    fileprivate func put(_ keys: String, for noteId: String, keep: @escaping Keep) {
        let keys = keys.replacingOccurrences(of: "\t", with: " ")
        seeds[noteId] = ((seeds[noteId]?.keys ?? "") + keys, keep)
    }

    /// `noteId`'s title editor appeared: it alone writes the note's title
    /// until it leaves. Returns the keys held for the note so far.
    func attach(_ noteId: String, absorb: @escaping Absorb) -> String? {
        titles[noteId] = ((titles[noteId]?.count ?? 0) + 1, absorb)
        let live = holds.allObjects.filter { $0.noteId == noteId }.map { $0.drain() }.joined()
        let keys = (take(noteId) ?? "") + live.replacingOccurrences(of: "\t", with: " ")
        return keys.isEmpty ? nil : keys
    }

    func detach(_ noteId: String) {
        guard let title = titles[noteId] else { return }
        titles[noteId] = title.count > 1 ? (title.count - 1, title.absorb) : nil
    }

    /// `noteId`'s title editor begins an edit: the keys go on its draft.
    func take(_ noteId: String) -> String? {
        seeds.removeValue(forKey: noteId)?.keys
    }

    /// Ends every hold and writes each seed: into its title editor when one
    /// is on screen, as the stored title otherwise.
    func flush() {
        holds.allObjects.forEach { $0.end() }
        let pending = seeds
        seeds = [:]
        for (noteId, seed) in pending {
            if let absorb = titles[noteId]?.absorb { absorb(seed.keys) } else { seed.keep(noteId, Self.title(seed.keys)) }
        }
    }

    /// The keys as one title line. With no page to take the caret there is
    /// no body to hand the text after a Return to, so it stays in the title.
    static func title(_ keys: String) -> String {
        keys.split(whereSeparator: \.isNewline).joined(separator: " ")
    }
}

/// The hidden text view that holds the keys.
private final class KeyHolder: UITextView {
    var hold: NewNoteKeys?

    override init(frame: CGRect, textContainer: NSTextContainer?) {
        super.init(frame: frame, textContainer: textContainer)
        alpha = 0
        isAccessibilityElement = false
        accessibilityElementsHidden = true
        autocorrectionType = .no
        spellCheckingType = .no
        smartQuotesType = .no
        smartDashesType = .no
        smartInsertDeleteType = .no
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    /// Before the input taking the caret begins editing, in the same turn.
    override func resignFirstResponder() -> Bool {
        let resigned = super.resignFirstResponder()
        if resigned { hold?.end() }
        return resigned
    }
}
