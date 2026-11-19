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
//  Invariant: every key held after ⌘N reaches the new note exactly once,
//  the line before a Return as its title and the rest as its body, or stays
//  on screen where it was typed. Every held key reaches durable storage
//  synchronously (the journal, `NewNoteJournal`) or under a background task
//  (the title write) before the app can be suspended or killed, without
//  waiting on the main actor after Home: as the app leaves, UIKit draws its
//  snapshot on the main thread while the core is still making the note, and
//  a kill 2 s after Home found keys only in memory (VERIFY-5087: 10 of 20
//  runs kept). So the keys a hold ends with before the note exists go to
//  the journal in the same call, and the keys held when the note is made
//  become its stored title at once, written off the main actor; the title
//  editor merges the keys after them (`NewNoteSeeds.attach`). Each key has
//  one owner at a time and moves by a hand-off that empties the giver: the
//  holder's text, then the hold's `waiting`, then the store's seed (`take`
//  removes it), then the title's draft or the `keep` write. The journal is
//  a copy, never an owner: it is cleared once the title write lands, and
//  only a launch after a kill reads it. The hold keeps the app running (a
//  background task) from ⌘N until the core made the note; a seed written
//  as the app leaves, and a title saved as it leaves, each hold their own
//  until the write lands.
//
//  The new note's title editor is the one owner of the keys held for it.
//  The hold never types them into a text input, whichever one takes the
//  caret from the holder (the title, the search palette, another note).
//  The title editor reads them outside its field's own edit callbacks,
//  where SwiftUI would draw its stale text over them: as it appears, before
//  its field takes the caret (the hold is drained then and keeps holding
//  until the field has the caret), and as its edit begins (whatever the
//  holder took meanwhile, `NewNoteSeeds`). A Return among them ends the
//  title there and the rest goes to the body, as a Return typed in the
//  title does. Nothing outside the page writes the title while the page is
//  on screen: the store hands a mounted title its seed and writes a seed as
//  the stored title only for a note whose page is not on screen, as the
//  page leaves or as the app goes to the background. A title that has not
//  appeared once the note is open ends the hold, so the caret is not kept
//  by a holder no one sees, and its keys are stored as the title at once.
//  A failed create discards the keys with a log
//  line next to the failure's alert. Another tab opened before the Notes
//  page took ⌘N parks the hold (`park`): its keys wait, journaled, and the
//  page makes their note when it takes the request.
//

import MemryCore
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
    /// Ends the background task begun at ⌘N.
    private var release: (() -> Void)?
    /// This hold's line in the journal: its id, its vault and when ⌘N came.
    private var entry: NewNoteJournal.Entry
    /// The open vault, which a journal entry is recovered into only.
    private let vault: () -> String?

    /// ⌘N: holds the keys typed from now on in `window`.
    init(
        window: UIWindow?, seeds: NewNoteSeeds = .shared, log: Log = .interface,
        vault: @escaping () -> String? = { LaunchSnapshot.shared.lastVault }
    ) {
        self.seeds = seeds
        self.log = log
        self.vault = vault
        entry = NewNoteJournal.Entry(
            hold: UUID().uuidString, vault: vault(), at: Int64(Date().timeIntervalSince1970 * 1000), keys: ""
        )
        hold(in: window)
    }

    /// Holds the keys typed from now on in `window`: at ⌘N, and at a second
    /// ⌘N after the hold was parked. A hold whose note exists takes no more.
    func hold(in window: UIWindow?) {
        guard holder == nil, noteId == nil, let window else { return }
        let holder = KeyHolder(frame: CGRect(x: 0, y: 0, width: 1, height: 1))
        window.addSubview(holder)
        guard holder.becomeFirstResponder() else {
            holder.removeFromSuperview()
            log.error("the keys typed after a new note could not be held")
            return
        }
        holder.hold = self
        self.holder = holder
        release = seeds.hold()
        seeds.holding(self)
    }

    /// The core made the note the keys are held for. `keep` writes a seed no
    /// title editor took as the note's title. The keys held so far are
    /// journaled with the note and become its stored title at once, under
    /// the write's own background task (`NewNoteSeeds.storeNow`): from here
    /// on nothing waits for the main actor to make them durable. The hold's
    /// background task ends here: from now on a seed or a title saved as the
    /// app leaves begins its own, in the same turn (`NewNoteSeeds.flush`).
    func made(_ noteId: String, keep: @escaping NewNoteSeeds.Keep) {
        self.noteId = noteId
        self.keep = keep
        let keys = waiting + drain()
        waiting = ""
        if !keys.isEmpty {
            journal(keys)
            seeds.put(keys, for: noteId, keep: keep)
            // The note was made after the app left: no title editor will run.
            if seeds.inBackground() { seeds.flush() } else { seeds.storeNow(noteId) }
        }
        seeds.log.debug("new note made, held keys", .count(keys.count))
        if holder != nil {
            // The note opens now: a title that has not appeared once the
            // page had time to draw never will (a page that could not open).
            // The keys become its stored title at once, durable and listed.
            Task { [seeds] in
                await seeds.settle()
                guard seeds.unshown(noteId) else { return }
                self.end()
                seeds.keep(noteId)
            }
        }
        releaseHold()
    }

    /// The core made no note: its alert is on screen, and the keys go.
    func failed() {
        let keys = waiting + (holder?.text ?? "")
        waiting = ""
        finish()
        releaseHold()
        seeds.journal?.clear(hold: entry.hold)
        if !keys.isEmpty {
            log.error("the keys typed after a new note were discarded: it was not created", .count(keys.count))
        }
    }

    /// Another tab opened before the Notes page took ⌘N: the keys held so
    /// far wait, journaled, for the note the page makes when it takes the
    /// request, or for the next launch's recovery.
    func park() {
        end()
        releaseHold()
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
        seeds.log.debug("new note hold ended", .count(keys.count))
        guard noteId == nil else { return seed(keys) }
        waiting += keys
        // The app may be leaving, with the core still making the note on a
        // main thread that stays busy until the kill: on disk now.
        if !keys.isEmpty { journal(waiting) }
    }

    /// Writes `keys`, every key this hold has not stored, to the journal.
    private func journal(_ keys: String) {
        // With no vault at ⌘N, the one open when the keys are journaled: an
        // entry with none is never recovered (`NewNoteJournal`).
        if entry.vault == nil { entry.vault = vault() }
        var entry = entry
        entry.keys = keys.replacingOccurrences(of: "\t", with: " ")
        entry.note = noteId
        seeds.journal?.record(entry)
    }

    private func releaseHold() {
        release?()
        release = nil
    }

    private func seed(_ keys: String) {
        guard let noteId, let keep, !keys.isEmpty else { return }
        seeds.put(keys, for: noteId, keep: keep)
        // The note was made after the app left: no title editor will run.
        if seeds.inBackground() { seeds.flush() }
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
    /// Writes `title` as `noteId`'s stored title, returning once it landed.
    /// Runs off the main actor, which the app's snapshot holds as it leaves.
    typealias Keep = @Sendable (_ noteId: String, _ title: String) async throws -> Void
    /// A mounted title editor takes `keys` into its edit and saves it.
    typealias Absorb = @MainActor (_ keys: String) -> Void

    static let shared = NewNoteSeeds(journal: .applicationSupport())

    /// Keeps the app running until the call it returns: a background task.
    let hold: () -> () -> Void
    /// How long an opened note's title has to appear (`NewNoteKeys.made`).
    let settle: () async -> Void
    /// The app is in the background, where no title editor runs.
    let inBackground: () -> Bool
    fileprivate let log: Log
    /// The keys held before their title landed, on disk (`NewNoteJournal`).
    /// `nil` keeps none: only the app's own store journals.
    let journal: NewNoteJournal?

    /// A note's held keys. `stored` is the title they were written as when
    /// the note was made (`storeNow`), which the page may show already.
    private struct Seed {
        var keys: String
        let keep: Keep
        var stored: String?
    }

    private var seeds: [String: Seed] = [:]
    /// Each note's last title write, which the next one waits for.
    private var writes: [String: Task<Void, Never>] = [:]
    /// A launch's recovery runs once at a time (`recover`).
    private var recovering = false
    private let holds = NSHashTable<NewNoteKeys>.weakObjects()
    /// The title editors on screen, by note: a redrawn page's title appears
    /// before the old one leaves, and the latest takes the keys.
    private var titles: [String: (count: Int, absorb: Absorb)] = [:]

    init(
        hold: @escaping () -> () -> Void = { ExchangeHold.application(named: "new-note-keys").begin() },
        settle: @escaping () async -> Void = { try? await Task.sleep(for: .seconds(2)) },
        inBackground: @escaping () -> Bool = { UIApplication.shared.applicationState == .background },
        log: Log = .interface,
        journal: NewNoteJournal? = nil
    ) {
        self.hold = hold
        self.settle = settle
        self.inBackground = inBackground
        self.log = log
        self.journal = journal
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
        seeds[noteId] = Seed(keys: (seeds[noteId]?.keys ?? "") + keys, keep: keep, stored: seeds[noteId]?.stored)
    }

    /// `noteId`'s title editor appeared: it alone writes the note's title
    /// until it leaves. Returns its edit with the keys held for the note so
    /// far after `title`, the text it shows, or `nil` with none held. A
    /// `title` that is the keys' own stored title (`storeNow`) is not
    /// repeated: the keys replace it.
    func attach(_ noteId: String, to title: String, absorb: @escaping Absorb) -> String? {
        titles[noteId] = ((titles[noteId]?.count ?? 0) + 1, absorb)
        let live = holds.allObjects.filter { $0.noteId == noteId }.map { $0.drain() }.joined()
        let seed = seeds.removeValue(forKey: noteId)
        let keys = (seed?.keys ?? "") + live.replacingOccurrences(of: "\t", with: " ")
        log.debug("new note title attached, keys", .count(keys.count))
        guard !keys.isEmpty else { return nil }
        return (title == seed?.stored ? "" : title) + keys
    }

    /// No title for `noteId` is on screen.
    fileprivate func unshown(_ noteId: String) -> Bool { titles[noteId] == nil }

    func detach(_ noteId: String) {
        guard let title = titles[noteId] else { return }
        titles[noteId] = title.count > 1 ? (title.count - 1, title.absorb) : nil
    }

    /// `noteId`'s title editor begins an edit: the keys go on its draft.
    func take(_ noteId: String) -> String? {
        let keys = seeds.removeValue(forKey: noteId)?.keys
        if let keys { log.debug("new note seed taken", .count(keys.count)) }
        return keys
    }

    /// Ends every hold and writes each seed: into its title editor when one
    /// is on screen, as the stored title otherwise.
    func flush() {
        log.debug("new note seeds flushed, holds", .count(holds.allObjects.count))
        holds.allObjects.forEach { $0.end() }
        let pending = seeds
        seeds = [:]
        for (noteId, seed) in pending {
            if let absorb = titles[noteId]?.absorb {
                log.debug("new note seed absorbed by its title", .count(seed.keys.count))
                absorb(seed.keys)
            } else {
                store(seed, as: noteId)
            }
        }
    }

    /// Writes `noteId`'s seed as its stored title: no title editor will take it.
    fileprivate func keep(_ noteId: String) {
        guard let seed = seeds.removeValue(forKey: noteId) else { return }
        store(seed, as: noteId)
    }

    /// Writes `noteId`'s seed as its stored title now, the moment the note
    /// exists, and keeps it for the title editor, which writes it again with
    /// the keys after it (`attach`).
    fileprivate func storeNow(_ noteId: String) {
        guard var seed = seeds[noteId] else { return }
        seed.stored = Self.title(seed.keys)
        seeds[noteId] = seed
        store(seed, as: noteId)
    }

    /// The last title write for `noteId` still landing, which a rename of
    /// the note waits for so the titles land in typed order.
    func landing(_ noteId: String) -> Task<Void, Never>? { writes[noteId] }

    /// The write starts off the main actor at once, after the note's write
    /// before it, and holds its own background task until it lands. A landed
    /// write clears the note's journal entry: its keys are in the vault.
    private func store(_ seed: Seed, as noteId: String) {
        log.debug("new note seed kept as its title", .count(seed.keys.count))
        let end = hold()
        let (keep, title, log, previous) = (seed.keep, Self.title(seed.keys), log, writes[noteId])
        let write = Task.detached { () -> Bool in
            await previous?.value
            do {
                try await keep(noteId, title)
                return true
            } catch {
                log.error("the keys typed after a new note could not be stored as its title")
                return false
            }
        }
        let landed = Task.detached { _ = await write.value }
        writes[noteId] = landed
        Task {
            if await write.value { journal?.clear(note: noteId) }
            if writes[noteId] == landed { writes[noteId] = nil }
            end()
        }
    }

    /// Stores the keys a killed launch journaled and never stored (#4787):
    /// as the title of the note the core made for them, when it is still
    /// untitled, or of a new note when the core never made one. Returns
    /// whether it wrote. An entry that fails stays for the next launch.
    func recover(vault: String, reader: any NotesReading, writer: any NotesWriting) async -> Bool {
        guard let journal, !recovering else { return false }
        recovering = true
        defer { recovering = false }
        let stranded = journal.stranded(in: vault)
        guard !stranded.isEmpty else { return false }
        let notes: [NoteSummary]
        do {
            notes = try await reader.list()
        } catch {
            log.error("the keys typed after a new note could not be recovered", .code(ErrorMapping.userFacing(error).code))
            return false
        }
        var wrote = false
        for (entry, note) in NewNoteJournal.Entry.matched(stranded, in: notes) {
            let title = Self.title(entry.keys)
            do {
                if let note {
                    if note.title.isEmpty {
                        try await writer.rename(id: note.id, title: title)
                        wrote = true
                    }
                } else {
                    _ = try await writer.create(title: title, folderPath: LocalSettings.shared.newNotesFolder)
                    wrote = true
                }
                journal.clear(hold: entry.hold)
                log.notice("the keys typed after a new note were recovered", .count(entry.keys.count))
            } catch {
                log.error("the keys typed after a new note could not be recovered", .code(ErrorMapping.userFacing(error).code))
            }
        }
        return wrote
    }

    /// The keys as one title line, a Return as a space. Where no body takes
    /// the text after a Return (no page on screen, or the caret left the
    /// title first), it stays in the title.
    static func title(_ keys: String) -> String {
        keys.split(whereSeparator: \.isNewline).joined(separator: " ")
    }
}

/// The keys held after ⌘N that may not be in the vault yet, in one small
/// file, `Application Support/new-note-keys.json`, so that a kill before
/// they land loses none (#4787). Local to this device and app: no vault or
/// sync format. Format, version 1:
///
///     {"v":1,"entries":[{"hold":"<uuid>","vault":"<vault id>|null",
///       "at":<⌘N, epoch ms>,"keys":"<text>","note":"<note id>|null"}]}
///
/// One entry per ⌘N whose keys are not stored yet. A hold writes its entry
/// as it ends before its note exists (`note` null) and again when the note
/// is made; the file is overwritten whole on each change, atomically, in
/// the caller's turn, and deleted when the last entry clears, which is when
/// its title write lands. A launch recovers the entries no hold of its own
/// wrote (`NewNoteSeeds.recover`) into their own vault only: the note named
/// by `note`, else the earliest untitled note the core made in the minute
/// after `at` that no earlier entry claimed, gets the keys as its title when
/// still untitled; with no such note, a new note is made with that title.
/// An entry with no vault is dropped unread: no vault is known to own it.
/// A file this build cannot read (another version) is logged and replaced.
/// The keys are the user's text in plaintext, so the file is excluded from
/// backup, like the vault (`FileProtection`), and a sign-out erases it.
@MainActor
final class NewNoteJournal {
    struct Entry: Codable, Equatable {
        let hold: String
        var vault: String?
        let at: Int64
        var keys: String
        var note: String?

        /// Each entry with the note the core made for it among `notes`, if
        /// it made one. Oldest ⌘N first, so each takes the earliest untitled
        /// note made after it that no earlier entry took.
        static func matched(_ entries: [Entry], in notes: [NoteSummary]) -> [(entry: Entry, note: NoteSummary?)] {
            // A note an entry names is that entry's alone.
            var claimed = Set(entries.compactMap(\.note))
            return entries.sorted { $0.at < $1.at }.map { entry in
                if let id = entry.note { return (entry, notes.first { $0.id == id }) }
                let note = entry.untitled(in: notes.filter { !claimed.contains($0.id) })
                if let note { claimed.insert(note.id) }
                return (entry, note)
            }
        }

        private func untitled(in notes: [NoteSummary]) -> NoteSummary? {
            // Made, and the app killed before it said so: the untitled note
            // created in the minute after ⌘N. One created before ⌘N is
            // another device's or another ⌘N's.
            let window: ClosedRange<Int64> = at...(at + 60000)
            let untitled = notes.filter { note in
                guard let created = note.createdAt else { return false }
                return note.title.isEmpty && window.contains(created)
            }
            return untitled.min { ($0.createdAt ?? 0) < ($1.createdAt ?? 0) }
        }
    }

    private struct File: Codable {
        var v = 1
        var entries: [Entry]
    }

    private let url: URL
    private let log: Log
    private var entries: [Entry]
    /// The holds of this launch, which recovery leaves to their own path.
    private var live: Set<String> = []

    init(url: URL, log: Log = .storage) {
        self.url = url
        self.log = log
        guard let data = try? Data(contentsOf: url) else {
            entries = []
            return
        }
        if let file = try? JSONDecoder().decode(File.self, from: data), file.v == 1 {
            entries = file.entries.filter { $0.vault != nil }
            if entries.count < file.entries.count {
                log.notice("new note keys with no vault were dropped", .count(file.entries.count - entries.count))
                write()
            }
        } else {
            log.error("the new note keys journal could not be read")
            entries = []
        }
    }

    static func applicationSupport() -> NewNoteJournal? {
        guard let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        else {
            Log.storage.error("the new note keys journal has no directory")
            return nil
        }
        return NewNoteJournal(url: support.appendingPathComponent("new-note-keys.json"))
    }

    /// The entries an earlier launch left for `vault`.
    func stranded(in vault: String) -> [Entry] {
        entries.filter { !live.contains($0.hold) && $0.vault == vault }
    }

    /// Sign-out: the keys of the account's vaults go with them.
    func erase() {
        entries = []
        live = []
        write()
    }

    func record(_ entry: Entry) {
        live.insert(entry.hold)
        entries.removeAll { $0.hold == entry.hold }
        entries.append(entry)
        write()
    }

    func clear(hold: String) {
        guard entries.contains(where: { $0.hold == hold }) else { return }
        entries.removeAll { $0.hold == hold }
        write()
    }

    func clear(note: String) {
        guard entries.contains(where: { $0.note == note }) else { return }
        entries.removeAll { $0.note == note }
        write()
    }

    private func write() {
        do {
            if entries.isEmpty {
                if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
                return
            }
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try JSONEncoder().encode(File(entries: entries))
                .write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            // An atomic write replaces the file, and its flag with it.
            var file = url
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            try file.setResourceValues(values)
        } catch {
            log.error("the new note keys journal could not be written", .code(ErrorMapping.userFacing(error).code))
        }
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
