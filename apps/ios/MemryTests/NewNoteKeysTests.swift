import MemryCore
import SwiftUI
import Testing
import UIKit
@testable import Memry

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
        keys.made("new") { _, _ in Issue.record("no page left") }
        #expect(seeds.take("new") == nil, "the hold still has the caret")
        let other = textView()
        other.becomeFirstResponder()

        #expect(body.text == "body line two")
        #expect(seeds.take("new") == "milk")
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
        keys.made("new") { _, _ in Issue.record("no page left") }

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
    func backgroundBeforeTheNoteKeepsTheKeys() throws {
        let seeds = NewNoteSeeds()
        textView().becomeFirstResponder()
        var kept: [String: String] = [:]

        let keys = NewNoteKeys(window: window, seeds: seeds)
        try type("milk\tlist\nbuy")
        seeds.flush()
        #expect(kept.isEmpty)
        keys.made("new") { kept[$0] = $1 }
        seeds.flush()

        #expect(kept == ["new": "milk list buy"])
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
        first.made("first") { _, _ in Issue.record("no page left") }
        second.made("second") { _, _ in Issue.record("no page left") }
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
        keys.made(noteId) { _, _ in Issue.record("no page left") }
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
        keys.made("new") { _, _ in Issue.record("the title is on screen") }
        #expect(seeds.attach("new") { _ in Issue.record("nothing was left") } == "milk")
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
        keys.made("new") { _, _ in Issue.record("the title is on screen") }
        _ = seeds.attach("new") { _ in Issue.record("the page before was redrawn") }
        _ = seeds.attach("new") { absorbed.append($0) }
        seeds.detach("new")
        try type("milk")
        seeds.flush()

        #expect(absorbed == ["milk"])
        #expect(firstResponder(in: window) == nil)
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
        keys.made(noteId) { _, _ in Issue.record("the page took no seed") }
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
