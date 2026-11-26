import MemryCore
import SwiftUI
import Synchronization
import Testing
import UIKit
@testable import Memry

extension KeyWindowSuites {
    /// #4787: the keys typed right after ⌘N belong to the new note's title,
    /// never to the note whose body had the caret or to any other text input,
    /// and none are dropped on the way.
    @Suite("Keys typed after ⌘N", .serialized)
    @MainActor
    struct NewNoteKeysTests {
        private let window: UIWindow = {
            let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 400, height: 400))
            window.rootViewController = UIViewController()
            window.isHidden = false
            return window
        }()

        private func textView() -> UITextView {
            let view = UITextView(frame: CGRect(x: 0, y: 0, width: 200, height: 40))
            window.rootViewController?.view.addSubview(view)
            return view
        }

        /// Types `text` as a keyboard does: into the window's first responder.
        private func type(_ text: String, in window: UIWindow? = nil) throws {
            let responder = try #require(firstResponder(in: window ?? self.window) as? UIKeyInput)
            responder.insertText(text)
        }

        private func firstResponder(in view: UIView) -> UIView? {
            if view.isFirstResponder { return view }
            return view.subviews.lazy.compactMap(firstResponder(in:)).first
        }

        @Test("keys typed while the note is made wait for its title, not the open body")
        func keysWaitForTheNewTitle() throws {
            let seeds = NewNoteSeeds()
            let body = textView()
            body.text = "body line two"
            body.becomeFirstResponder()

            let keys = NewNoteKeys(window: window, seeds: seeds)
            try type("milk")
            keys.made("new") { _, _ in }
            try type("s")
            let other = textView()
            other.becomeFirstResponder()

            #expect(body.text == "body line two")
            #expect(seeds.take("new") == "milks")
        }

        @Test("a text input that is not the new title gets none of the keys")
        func anotherInputGetsNothing() throws {
            let seeds = NewNoteSeeds()
            textView().becomeFirstResponder()

            let keys = NewNoteKeys(window: window, seeds: seeds)
            try type("milk")
            let search = textView()
            search.becomeFirstResponder()
            try type("q")
            keys.made("new") { _, _ in }

            #expect(search.text == "q")
            #expect(seeds.take("new") == "milk")
        }

        @Test("a holder that cannot take the caret ends the hold and leaves nothing behind")
        func refusedCaretEndsTheHold() throws {
            let seeds = NewNoteSeeds()
            let lines = LogLines()
            let body = Clinging(frame: CGRect(x: 0, y: 0, width: 200, height: 40))
            window.rootViewController?.view.addSubview(body)
            body.becomeFirstResponder()
            let before = window.subviews.count

            let keys = NewNoteKeys(window: window, seeds: seeds, log: lines.log)
            try type("x")
            keys.made("new") { _, _ in Issue.record("nothing was held") }

            #expect(window.subviews.count == before)
            #expect(body.text == "x")
            #expect(seeds.take("new") == nil)
            #expect(lines.all == ["the keys typed after a new note could not be held"])
        }

        @Test("a failed create discards the keys and says so")
        func failedCreateDiscardsTheKeys() throws {
            let seeds = NewNoteSeeds()
            let lines = LogLines()
            textView().becomeFirstResponder()

            let keys = NewNoteKeys(window: window, seeds: seeds, log: lines.log)
            try type("milk")
            keys.failed()
            seeds.flush()

            #expect(firstResponder(in: window) == nil)
            #expect(lines.all == ["the keys typed after a new note were discarded: it was not created [count=4]"])
        }

        /// `flush` is what leaving the app runs (`didEnterBackgroundNotification`);
        /// called directly, as the notification reaches every suite's pages.
        @Test("leaving the app before the note is made stores the keys as its title once it is")
        func backgroundBeforeTheNoteKeepsTheKeys() async throws {
            let seeds = NewNoteSeeds()
            textView().becomeFirstResponder()
            let kept = Mutex<[String: String]>([:])

            let keys = NewNoteKeys(window: window, seeds: seeds)
            try type("milk\tlist\nbuy")
            seeds.flush()
            #expect(kept.withLock { $0.isEmpty })
            keys.made("new") { id, title in kept.withLock { $0[id] = title } }
            seeds.flush()
            for _ in 0..<100 where kept.withLock({ $0.isEmpty }) {
                try await Task.sleep(for: .milliseconds(10))
            }

            #expect(kept.withLock { $0 } == ["new": "milk list buy"])
            #expect(seeds.take("new") == nil)
        }

        @Test("a second ⌘N before the first note is made keeps each note's keys apart")
        func secondNewNoteKeepsTheFirstKeys() throws {
            let seeds = NewNoteSeeds()
            textView().becomeFirstResponder()

            let first = NewNoteKeys(window: window, seeds: seeds)
            try type("one")
            let second = NewNoteKeys(window: window, seeds: seeds)
            try type("two")
            first.made("first") { _, _ in }
            second.made("second") { _, _ in }
            textView().becomeFirstResponder()

            #expect(seeds.take("first") == "one")
            #expect(seeds.take("second") == "two")
        }

        /// The Notes page takes ⌘N's request on a later SwiftUI update; keys
        /// queued behind ⌘N reached the open note before it (iPad HID).
        @Test("⌘N holds the keys at once, before the Notes page takes its request, and a second ⌘N joins the first")
        func commandHoldsBeforeThePageTakesIt() throws {
            let links = NotesLinks()
            let body = textView()
            body.becomeFirstResponder()
            let noteId = UUID().uuidString

            links.requestNewNote(window: window)
            try type("mi")
            links.requestNewNote(window: window)
            try type("lk")
            let keys = try #require(links.takeNewNote())
            keys.made(noteId) { _, _ in }
            textView().becomeFirstResponder()

            #expect(body.text.isEmpty)
            #expect(links.takeNewNote() == nil)
            #expect(NewNoteSeeds.shared.take(noteId) == "milk")
        }

        @Test("the title appearing takes the keys held so far, and the hold keeps the caret until its field takes it")
        func appearingTitleDrainsTheHold() throws {
            let seeds = NewNoteSeeds()
            textView().becomeFirstResponder()

            let keys = NewNoteKeys(window: window, seeds: seeds)
            try type("milk")
            keys.made("new") { _, _ in }
            #expect(seeds.attach("new", to: "") { _ in Issue.record("nothing was left") } == "milk")
            try type("s")
            textView().becomeFirstResponder()

            #expect(seeds.take("new") == "s")
        }

        @Test("leaving the app hands a title on screen its keys rather than writing the title")
        func backgroundHandsAMountedTitleItsKeys() throws {
            let seeds = NewNoteSeeds()
            textView().becomeFirstResponder()
            var absorbed: [String] = []

            let keys = NewNoteKeys(window: window, seeds: seeds)
            keys.made("new") { _, _ in }
            _ = seeds.attach("new", to: "") { _ in Issue.record("the page before was redrawn") }
            _ = seeds.attach("new", to: "") { absorbed.append($0) }
            seeds.detach("new")
            try type("milk")
            seeds.flush()

            #expect(absorbed == ["milk"])
            #expect(firstResponder(in: window) == nil)
        }


        /// #4787 (VERIFY-5087 1): ⌘N, typing and Home in one burst, then a kill
        /// 2 s later lost every key. iOS suspends the app once it holds no
        /// background task, and a kill then ends it: `released` records, each
        /// time the last task ends, the title that had landed by then.
        @Test(.timeLimit(.minutes(1)), arguments: [true, false])
        func leavingTheAppStoresTheKeysBeforeItMayBeSuspended(beforeTheNote: Bool) async throws {
            let holds = Holds()
            var background = false
            let seeds = NewNoteSeeds(hold: { holds.begin() }, inBackground: { background })
            textView().becomeFirstResponder()
            let vault = try TasksTestVault()
            let writer = CoreNotesWriter(vault: vault.vault, store: TaskTestKeychain(), executor: .shared)
            let landed = Mutex<String?>(nil)
            holds.released = { landed.withLock { $0 } }

            let keys = NewNoteKeys(window: window, seeds: seeds)
            try type("milk")
            if beforeTheNote {
                background = true
                seeds.flush()
                #expect(holds.open == 1, "nothing keeps the app running while the note is made")
            }
            let noteId = try await writer.create(title: "", folderPath: nil)
            keys.made(noteId) { id, title in
                try? await writer.rename(id: id, title: title)
                landed.withLock { $0 = title }
            }
            if !beforeTheNote {
                background = true
                seeds.flush()
            }
            for _ in 0..<300 where holds.open > 0 {
                try await Task.sleep(for: .milliseconds(20))
            }

            // Stored as the note is made: no release before the title landed.
            #expect(holds.landedAtRelease == ["milk"])
            let stored = try await CoreNotesReader(vault: vault.vault, executor: .shared).read(id: noteId)
            #expect(stored?.summary.title == "milk")
        }

        /// #4787 (VERIFY-5087 3): an opened note whose page never drew its title
        /// (iPhone, where the page did not open) kept the caret in the holder,
        /// and every key typed after went nowhere the user could see.
        @Test("a title that has not appeared once the note is open ends the hold and stores the keys as its title")
        func noTitleOnceTheNoteIsOpenEndsTheHold() async throws {
            var settled: CheckedContinuation<Void, Never>?
            let holds = Holds()
            let seeds = NewNoteSeeds(hold: { holds.begin() }, settle: { await withCheckedContinuation { settled = $0 } })
            textView().becomeFirstResponder()
            let kept = Mutex<[String: String]>([:])

            let keys = NewNoteKeys(window: window, seeds: seeds)
            try type("milk")
            keys.made("new") { id, title in kept.withLock { $0[id] = title } }
            await until { settled != nil }
            try type("s")
            settled?.resume()
            await until { holds.open == 0 && kept.withLock { $0["new"] == "milks" } }

            #expect(firstResponder(in: window) == nil)
            #expect(kept.withLock { $0 } == ["new": "milks"])
            #expect(seeds.take("new") == nil)
            #expect(holds.open == 0)
        }

        /// #4787 (VERIFY-5087 2): a held key reached the title twice. Each
        /// hand-off empties its giver, so a key moves once, whichever path it takes.
        @Test("every key held after ⌘N reaches the title exactly once")
        func eachKeyReachesTheTitleOnce() throws {
            let seeds = NewNoteSeeds()
            textView().becomeFirstResponder()
            var absorbed: [String] = []

            let keys = NewNoteKeys(window: window, seeds: seeds)
            try type("kz")
            keys.made("new") { _, _ in }
            #expect(seeds.attach("new", to: "") { absorbed.append($0) } == "kz")
            try type("h2")
            seeds.flush()
            seeds.flush()

            #expect(absorbed == ["h2"])
            #expect(seeds.take("new") == nil)
        }

        /// The keys are stored as the title when the note is made, and the page
        /// may read that title before its title editor appears: the editor's
        /// edit is the keys once, not the stored title followed by the keys.
        @Test("a title showing the keys already stored for it takes them once", arguments: ["", "kz"])
        func aStoredTitleTakesTheKeysOnce(shown: String) throws {
            let seeds = NewNoteSeeds()
            textView().becomeFirstResponder()

            let keys = NewNoteKeys(window: window, seeds: seeds)
            try type("kz")
            keys.made("new") { _, _ in }
            try type("h")

            #expect(seeds.attach("new", to: shown) { _ in } == "kzh")
        }

        /// #4787 (VERIFY-5087 round 2, K1): `made` with keys held ended the ⌘N
        /// hold, and nothing stored them until the main actor ran again, which
        /// it did not before the kill.
        @Test("keys held when the note is made are stored as its title with the main actor blocked", .timeLimit(.minutes(1)))
        func madeStoresTheHeldKeysWithoutTheMainActor() async throws {
            let holds = Holds()
            let seeds = NewNoteSeeds(hold: { holds.begin() })
            textView().becomeFirstResponder()
            let vault = try TasksTestVault()
            let writer = CoreNotesWriter(vault: vault.vault, store: TaskTestKeychain(), executor: .shared)
            let noteId = try await writer.create(title: "", folderPath: nil)
            let landed = Mutex<String?>(nil)

            let keys = NewNoteKeys(window: window, seeds: seeds)
            try type("milk")
            keys.made(noteId) { id, title in
                try await writer.rename(id: id, title: title)
                landed.withLock { $0 = title }
            }
            // The main thread stays busy, as it is drawing the app's snapshot
            // after Home: no main-actor turn runs until the write landed.
            let deadline = Date().addingTimeInterval(20)
            while landed.withLock({ $0 }) == nil, Date() < deadline { usleep(10_000) }

            #expect(landed.withLock { $0 } == "milk")
            #expect(holds.open == 1, "the write runs under its own background task")
            let stored = try await CoreNotesReader(vault: vault.vault, executor: .shared).read(id: noteId)
            #expect(stored?.summary.title == "milk")
        }

        /// #4787 (VERIFY-5087 round 2, K2): the app left before the core made the
        /// note, the keys waited in memory, and a kill before `made` lost them.
        /// The journal holds them on disk from the moment the hold ends, and the
        /// next launch stores them in the note made for them, or a new one.
        @Test("keys held when the app leaves before the note is made survive a kill", .timeLimit(.minutes(1)), arguments: [true, false])
        func keysJournaledBeforeTheNoteSurviveAKill(noteMade: Bool) async throws {
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("new-note-keys-\(UUID().uuidString).json")
            defer { try? FileManager.default.removeItem(at: url) }
            let seeds = NewNoteSeeds(journal: NewNoteJournal(url: url))
            textView().becomeFirstResponder()
            let vault = try TasksTestVault()
            let writer = CoreNotesWriter(vault: vault.vault, store: TaskTestKeychain(), executor: .shared)
            let reader = CoreNotesReader(vault: vault.vault, executor: .shared)

            let keys = NewNoteKeys(window: window, seeds: seeds, vault: { "v1" })
            try type("milk\tlist")
            seeds.flush()
            // On disk in the same call, before any later turn.
            let journaled = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any]
            #expect(journaled?["v"] as? Int == 1)
            #expect((journaled?["entries"] as? [[String: Any]])?.first?["keys"] as? String == "milk list")
            let made = noteMade ? try await writer.create(title: "", folderPath: nil) : nil
            _ = keys // killed: `made` never runs

            // The next launch.
            let relaunched = NewNoteSeeds(journal: NewNoteJournal(url: url))
            #expect(await relaunched.recover(vault: "other", reader: reader, writer: writer) == false)
            #expect(await relaunched.recover(vault: "v1", reader: reader, writer: writer))

            let notes = try await reader.list()
            #expect(notes.map(\.title) == ["milk list"], "one note, titled once")
            if let made { #expect(notes.first?.id == made) }
            #expect(!FileManager.default.fileExists(atPath: url.path), "the journal clears once stored")
            #expect(await relaunched.recover(vault: "v1", reader: reader, writer: writer) == false)
        }

        @Test("the journal entry clears once the title write lands, and a failed write keeps it", .timeLimit(.minutes(1)))
        func theJournalClearsWhenTheTitleLands() async throws {
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("new-note-keys-\(UUID().uuidString).json")
            defer { try? FileManager.default.removeItem(at: url) }
            let holds = Holds()
            let seeds = NewNoteSeeds(hold: { holds.begin() }, journal: NewNoteJournal(url: url))
            textView().becomeFirstResponder()

            let failing = NewNoteKeys(window: window, seeds: seeds, vault: { "v1" })
            try type("one")
            failing.made("first") { _, _ in throw CancellationError() }
            await until { holds.open == 0 }
            #expect(NewNoteJournal(url: url).stranded(in: "v1").map(\.keys) == ["one"])

            let landing = NewNoteKeys(window: window, seeds: seeds, vault: { "v1" })
            try type("two")
            landing.made("second") { _, _ in }
            #expect(NewNoteJournal(url: url).stranded(in: "v1").map(\.note) == ["first", "second"])
            await until { holds.open == 0 }
            #expect(NewNoteJournal(url: url).stranded(in: "v1").map(\.note) == ["first"])
        }

        @Test("the journal, the user's text in plaintext, is excluded from backup after every write")
        func theJournalStaysOutOfBackups() throws {
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("new-note-keys-\(UUID().uuidString).json")
            defer { try? FileManager.default.removeItem(at: url) }
            let journal = NewNoteJournal(url: url)

            for keys in ["m", "mi"] {
                journal.record(NewNoteJournal.Entry(hold: "h", vault: "v1", at: 0, keys: keys))
                let fresh = URL(fileURLWithPath: url.path)
                #expect(try fresh.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup == true)
            }
        }

        @Test("keys journaled with no vault open are never recovered, and a vault open by the write owns them", .timeLimit(.minutes(1)))
        func keysWithNoVaultAreNotRecoveredElsewhere() async throws {
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("new-note-keys-\(UUID().uuidString).json")
            defer { try? FileManager.default.removeItem(at: url) }
            let seeds = NewNoteSeeds(journal: NewNoteJournal(url: url))
            textView().becomeFirstResponder()
            let vault = try TasksTestVault()
            let writer = CoreNotesWriter(vault: vault.vault, store: TaskTestKeychain(), executor: .shared)
            let reader = CoreNotesReader(vault: vault.vault, executor: .shared)

            let unowned = NewNoteKeys(window: window, seeds: seeds, vault: { nil })
            try type("milk")
            seeds.flush()
            var open: String?
            let owned = NewNoteKeys(window: window, seeds: seeds, vault: { open })
            open = "v1"
            try type("eggs")
            seeds.flush()
            _ = (unowned, owned) // killed: `made` never runs

            let relaunched = NewNoteSeeds(journal: NewNoteJournal(url: url))
            #expect(await relaunched.recover(vault: "v2", reader: reader, writer: writer) == false)
            #expect(await relaunched.recover(vault: "v1", reader: reader, writer: writer))
            #expect(try await reader.list().map(\.title) == ["eggs"])
            #expect(!FileManager.default.fileExists(atPath: url.path), "the entry with no vault is dropped")
        }

        @Test("recovery gives each ⌘N, oldest first, the earliest untitled note made after it that no other took")
        func recoveryClaimsEachNoteOnce() {
            func note(_ id: String, _ created: Int64) -> NoteSummary {
                NoteSummary(id: id, title: "", folderPath: nil, emoji: nil, createdAt: created, modifiedAt: nil, aliases: [])
            }
            let entries = [
                NewNoteJournal.Entry(hold: "b", vault: "v1", at: 10200, keys: "b"),
                NewNoteJournal.Entry(hold: "a", vault: "v1", at: 10000, keys: "a"),
                NewNoteJournal.Entry(hold: "c", vault: "v1", at: 10100, keys: "c", note: "named"),
            ]
            let notes = [note("n2", 10300), note("n1", 10250), note("named", 10150), note("foreign", 9500)]

            let matched = NewNoteJournal.Entry.matched(entries, in: notes).map { "\($0.entry.hold)=\($0.note?.id ?? "-")" }

            #expect(matched == ["a=n1", "c=named", "b=n2"])
        }

        /// The Notes page takes the request when it loads; another tab before
        /// that used to drop the keys with a log line.
        @Test("another tab before the Notes page takes ⌘N keeps the keys for the note it makes later")
        func aTabSwitchKeepsTheHeldKeys() throws {
            let links = NotesLinks()
            let body = textView()
            body.becomeFirstResponder()
            let noteId = UUID().uuidString

            links.requestNewNote(window: window)
            try type("mi")
            links.parkNewNote()
            links.requestNewNote(window: window)
            try type("lk")
            let keys = try #require(links.takeNewNote())
            keys.made(noteId) { _, _ in }
            textView().becomeFirstResponder()

            #expect(body.text.isEmpty)
            #expect(NewNoteSeeds.shared.take(noteId) == "milk")
        }

        /// REVIEW-5087 #3: a parked request with nothing typed made a blank note
        /// whenever the Notes page next loaded.
        @Test("another tab before any key is typed after ⌘N drops the request")
        func aTabSwitchWithNoKeysDropsTheRequest() {
            let links = NotesLinks()
            textView().becomeFirstResponder()

            links.requestNewNote(window: window)
            links.parkNewNote()

            #expect(links.takeNewNote() == nil)
        }

        /// REVIEW-5087 #1: a note made after a sign-out or a vault switch is in
        /// another vault than the one the keys were typed in.
        @Test("keys typed in one vault never title a note made in another, and stay journaled for theirs")
        func keysStayWithTheirVault() throws {
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("new-note-keys-\(UUID().uuidString).json")
            defer { try? FileManager.default.removeItem(at: url) }
            let seeds = NewNoteSeeds(journal: NewNoteJournal(url: url))
            textView().becomeFirstResponder()
            var open: String? = "v1"

            let keys = NewNoteKeys(window: window, seeds: seeds, vault: { open })
            try type("milk")
            open = "v2"
            keys.made("new") { _, _ in Issue.record("no title is written") }

            #expect(seeds.take("new") == nil)
            #expect(NewNoteJournal(url: url).stranded(in: "v1").map(\.keys) == ["milk"])
            #expect(NewNoteJournal(url: url).stranded(in: "v2").isEmpty)
        }

        /// #5820: an iPad window going to the background while others stay
        /// posts only its scene's notification. The keys held in that window end
        /// their hold and are written; another window's hold and keys stay.
        @Test("a window going to the background ends only its own hold and writes only its note's keys")
        func aWindowLeavingEndsOnlyItsHold() throws {
            let center = NotificationCenter()
            let seeds = NewNoteSeeds(notifications: center)
            textView().becomeFirstResponder()
            let staying = NewNoteKeys(window: window, seeds: seeds)
            try type("kz")
            staying.made("there") { _, _ in }
            let leaving = try sceneWindow()
            leaving.rootViewController = UIViewController()
            // Visible, not key: the key window belongs to the suites running alongside.
            leaving.isHidden = false
            defer { leaving.isHidden = true }
            let scene = try #require(leaving.windowScene)
            try #require(window.windowScene !== scene, "the other window shares the leaving one's scene")

            let keys = NewNoteKeys(window: leaving, seeds: seeds)
            try type("milk", in: leaving)
            keys.made("here") { _, _ in }
            center.post(name: UIScene.didEnterBackgroundNotification, object: scene)

            #expect(firstResponder(in: leaving) == nil, "the leaving window's hold did not end")
            #expect(seeds.take("here") == nil, "the leaving window's keys were not written")
            #expect(firstResponder(in: window) != nil, "the other window's hold ended")
            #expect(seeds.take("there") == "kz", "the other window's keys were written")
        }

        /// A scene notification that names no scene ends no hold: only the app
        /// leaving ends every one.
        @Test("a scene notification for no scene ends no hold")
        func anUnrelatedSceneNotificationEndsNoHold() throws {
            let center = NotificationCenter()
            let seeds = NewNoteSeeds(notifications: center)
            textView().becomeFirstResponder()

            let keys = NewNoteKeys(window: window, seeds: seeds)
            try type("milk")
            keys.made("new") { _, _ in }
            center.post(name: UIScene.didEnterBackgroundNotification, object: NSObject())

            #expect(firstResponder(in: window) != nil, "the hold ended")
            #expect(seeds.take("new") == "milk", "the keys were written")
        }

        @Test("a title that appeared keeps the hold until its field takes the caret")
        func aShownTitleKeepsTheHold() async throws {
            var settled: CheckedContinuation<Void, Never>?
            let seeds = NewNoteSeeds(settle: { await withCheckedContinuation { settled = $0 } })
            textView().becomeFirstResponder()

            let keys = NewNoteKeys(window: window, seeds: seeds)
            try type("milk")
            keys.made("new") { _, _ in }
            _ = seeds.attach("new", to: "") { _ in Issue.record("the app did not leave") }
            await until { settled != nil }
            settled?.resume()
            await Task.yield()
            try type("s")

            #expect(seeds.take("new") == nil, "the hold ended")
            textView().becomeFirstResponder()
            #expect(seeds.take("new") == "s")
        }

        // MARK: The new note's page

        private struct Page {
            let vault: TasksTestVault
            let noteId: String
            let reader: CoreNotesReader
            let window: UIWindow
        }

        /// ⌘N from a page whose body has the caret: `typed` goes to the hold,
        /// then the core makes the note and its page draws in the same window.
        private func newNote(typing typed: String, in window: UIWindow) async throws -> Page {
            window.rootViewController = UIViewController()
            window.makeKeyAndVisible()
            let old = UITextView(frame: CGRect(x: 0, y: 0, width: 200, height: 40))
            window.rootViewController?.view.addSubview(old)
            old.becomeFirstResponder()

            let keys = NewNoteKeys(window: window)
            try type(typed, in: window)
            let vault = try TasksTestVault()
            let noteId = try await CoreNotesWriter(vault: vault.vault, store: TaskTestKeychain(), executor: .shared)
                .create(title: "", folderPath: nil)
            // Stored as the title at once, as the app does: the page may read it.
            let writer = CoreNotesWriter(vault: vault.vault, store: TaskTestKeychain(), executor: .shared)
            keys.made(noteId) { try await writer.rename(id: $0, title: $1) }
            let reader = CoreNotesReader(vault: vault.vault, executor: .shared)
            window.rootViewController = UIHostingController(rootView: NoteReadView(
                route: NoteRoute(id: noteId), reader: reader, filler: NoBodies(),
                editor: CoreBlockEditor(vault: vault.vault, store: TaskTestKeychain(), executor: .shared),
                metadataWriter: CoreNoteMetadataWriter(vault: vault.vault, store: TaskTestKeychain(), executor: .shared)
            ))
            #expect(old.text.isEmpty, "the keys leaked into the note left behind")
            return Page(vault: vault, noteId: noteId, reader: reader, window: window)
        }

        private func sceneWindow() throws -> UIWindow {
            UIWindow(windowScene: try #require(UIApplication.shared.connectedScenes.first as? UIWindowScene))
        }

        private func views<T: UIView>(_ type: T.Type, in window: UIWindow) -> [T] {
            func all(_ view: UIView) -> [T] { ((view as? T).map { [$0] } ?? []) + view.subviews.flatMap(all) }
            return window.rootViewController?.view.map(all) ?? []
        }

        private func title(in window: UIWindow) -> UITextView? {
            views(UITextView.self, in: window).first { !($0 is BlockTextView) }
        }

        private func until(_ condition: () -> Bool) async {
            for _ in 0..<300 where !condition() {
                try? await Task.sleep(for: .milliseconds(20))
            }
        }

        private func stored(_ page: Page) async throws -> (title: String?, body: [String]) {
            let detail = try await page.reader.read(id: page.noteId)
            let blocks = try await page.reader.blocks(id: page.noteId) ?? []
            return (detail?.summary.title, blocks.map { $0.inline.map(\.text).joined() })
        }

        /// Runs `scenario` on a new scene window until no other suite made its
        /// window key meanwhile, and returns what it saw. Suites run in parallel
        /// in this process, and a window made key elsewhere takes the caret: such
        /// a run proves nothing either way (as in `NoteTitleBurstTests`).
        /// `scenario` gets the window and whether to type `s` the moment the new
        /// title begins editing, ahead of the page's focus change.
        private func uninterrupted<T>(
            typingAtOnce atOnce: Bool, _ scenario: @MainActor (UIWindow, @MainActor () -> Bool) async throws -> T
        ) async throws -> T {
            var attempt = 0
            while true {
                attempt += 1
                let window = try sceneWindow()
                var typedAtOnce = false
                var resigned = false
                let began = NotificationCenter.default.addObserver(
                    forName: UITextView.textDidBeginEditingNotification, object: nil, queue: nil
                ) { note in
                    let view = note.object as? UITextView
                    MainActor.assumeIsolated {
                        guard atOnce, !typedAtOnce, let view, view.window === window, !(view is BlockTextView),
                              window.rootViewController is UIHostingController<NoteReadView>
                        else { return }
                        typedAtOnce = true
                        view.insertText("s")
                    }
                }
                let resign = NotificationCenter.default.addObserver(
                    forName: UIWindow.didResignKeyNotification, object: window, queue: nil
                ) { _ in
                    MainActor.assumeIsolated { resigned = true }
                }
                let seen = try await scenario(window) { typedAtOnce }
                NotificationCenter.default.removeObserver(began)
                NotificationCenter.default.removeObserver(resign)
                window.isHidden = true
                if !resigned || attempt == 10 { return seen }
                try await Task.sleep(for: .milliseconds(200 * attempt))
            }
        }

        /// The reviewer's case: `milk` held, then `s` typed in the title, the
        /// moment its text view begins editing or once the page has settled. The
        /// title editor starts its edit from the held keys either way.
        @Test(.timeLimit(.minutes(3)), arguments: [true, false])
        func keysHeldThenTypedInTheTitleKeepTheirOrder(atOnce: Bool) async throws {
            let seen = try await uninterrupted(typingAtOnce: atOnce) { window, typedAtOnce in
                let page = try await newNote(typing: "milk", in: window)
                await until { title(in: window)?.isFirstResponder == true }
                let field = try #require(title(in: window))
                if !atOnce { field.insertText("s") }
                await until { field.text == "milks" }
                let first = field.text
                field.insertText("!")
                let second = field.text
                // Leaving the page ends the edit (#2680).
                window.rootViewController = UIViewController()
                for _ in 0..<300 where try await stored(page).title != "milks!" {
                    try await Task.sleep(for: .milliseconds(20))
                }
                return (typedAtOnce(), first, second, try await stored(page))
            }

            #expect(seen.0 == atOnce)
            #expect(seen.1 == "milks")
            #expect(seen.2 == "milks!")
            #expect(seen.3.title == "milks!", "\(seen.3)")
            #expect(seen.3.body == [""], "\(seen.3)")
        }

        /// `milk⏎buy` held, then `s` typed the moment the title begins editing
        /// or not at all: the title is `milk` and the body gets the rest in order.
        @Test(.timeLimit(.minutes(3)), arguments: [true, false])
        func aReturnInTheHeldKeysEndsTheTitleAndTheRestGoesToTheBody(atOnce: Bool) async throws {
            let body = atOnce ? "buys" : "buy"
            let seen = try await uninterrupted(typingAtOnce: atOnce) { window, typedAtOnce in
                let page = try await newNote(typing: "milk\nbuy", in: window)
                await until { views(BlockTextView.self, in: window).first?.text == body }
                let block = views(BlockTextView.self, in: window).first
                let caret = block?.isFirstResponder == true
                block?.resignFirstResponder()
                for _ in 0..<300 where try await stored(page) != ("milk", [body]) {
                    try await Task.sleep(for: .milliseconds(20))
                }
                await until { title(in: window)?.text == "milk" }
                return (typedAtOnce(), caret, try await stored(page), title(in: window)?.text)
            }

            #expect(seen.0 == atOnce)
            #expect(seen.2.title == "milk", "\(seen.2)")
            #expect(seen.3 == "milk")
            // The title takes the held keys the moment it has the caret, which
            // can come before the page has read its blocks; its Return then
            // loses the keys after it (#5119, the body's defect).
            withKnownIssue("#5119: a Return before the blocks are read", isIntermittent: true) {
                #expect(seen.1, "the caret stayed in the title")
                #expect(seen.2.body == [body], "\(seen.2)")
            }
        }

        /// #4787 (VERIFY-5087 4): the palette over the window keeps its caret,
        /// and its Escape, when a new note's title appears under it.
        @Test(.timeLimit(.minutes(3)))
        func aTitleUnderThePaletteLeavesItTheCaret() async throws {
            let seen = try await uninterrupted(typingAtOnce: false) { window, _ in
                let root = UIViewController()
                window.rootViewController = root
                window.makeKeyAndVisible()
                let palette = UIViewController()
                palette.modalPresentationStyle = .formSheet
                let query = UITextField(frame: CGRect(x: 0, y: 0, width: 200, height: 40))
                palette.view.addSubview(query)
                root.present(palette, animated: false)
                query.becomeFirstResponder()

                let vault = try TasksTestVault()
                let noteId = try await CoreNotesWriter(vault: vault.vault, store: TaskTestKeychain(), executor: .shared)
                    .create(title: "", folderPath: nil)
                let page = UIHostingController(rootView: NoteReadView(
                    route: NoteRoute(id: noteId), reader: CoreNotesReader(vault: vault.vault, executor: .shared),
                    filler: NoBodies(),
                    editor: CoreBlockEditor(vault: vault.vault, store: TaskTestKeychain(), executor: .shared),
                    metadataWriter: CoreNoteMetadataWriter(vault: vault.vault, store: TaskTestKeychain(), executor: .shared)
                ))
                root.addChild(page)
                page.view.frame = root.view.bounds
                root.view.addSubview(page.view)
                page.didMove(toParent: root)
                await until { title(in: window) != nil }
                try await Task.sleep(for: .milliseconds(500))
                let seen = (title(in: window)?.isFirstResponder, query.isFirstResponder)
                palette.dismiss(animated: false)
                return seen
            }

            #expect(seen.0 == false, "the title took the caret from the palette")
            #expect(seen.1 == true)
        }

    }
}

/// Background tasks, counted: `released` reads what had landed each time
/// the last one ends, the moment iOS may suspend the app.
@MainActor
private final class Holds {
    private(set) var open = 0
    private(set) var landedAtRelease: [String?] = []
    var released: () -> String? = { nil }

    func begin() -> () -> Void {
        open += 1
        var ended = false
        return { [self] in
            guard !ended else { return }
            ended = true
            open -= 1
            if open == 0 { landedAtRelease.append(released()) }
        }
    }
}

/// A body that keeps the caret.
private final class Clinging: UITextView {
    override var canResignFirstResponder: Bool { false }
}

/// The log lines a test's code writes.
private final class LogLines: @unchecked Sendable {
    private let lock = NSLock()
    private var lines: [String] = []
    var all: [String] { lock.withLock { lines } }
    lazy var log = Log(capturing: { [self] _, line in lock.withLock { lines.append(line) } })
}

/// Body pulls that reach no server.
private final class NoBodies: VaultFilling, @unchecked Sendable {
    func isFirstSyncComplete() async throws -> Bool { true }
    func firstSync(
        progress: @escaping @MainActor @Sendable (SyncProgress) -> Void
    ) async throws -> FirstSyncSummary { .none }
    func pullNoteBody(noteId: String) async throws -> BodyFetchSummary {
        BodyFetchSummary(updates: 0, baselines: 0, stopped: false)
    }
}
