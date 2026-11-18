import Testing
import UIKit
@testable import Memry

/// #4787: the keys typed right after ⌘N belong to the new note, never to the
/// note whose body had the caret, and none are dropped on the way.
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
    private func type(_ text: String) throws {
        let responder = try #require(firstResponder(in: window) as? UIKeyInput)
        responder.insertText(text)
    }

    private func firstResponder(in view: UIView) -> UIView? {
        if view.isFirstResponder { return view }
        return view.subviews.lazy.compactMap(firstResponder(in:)).first
    }

    @Test("keys typed while the note is made go into its title, not the open body")
    func keysReachTheNewTitle() throws {
        let body = textView()
        body.text = "body line two"
        body.becomeFirstResponder()

        let keys = NewNoteKeys(window: window) { _, _ in Issue.record("the title took the keys") }
        try type("milk")
        keys.made("new")
        let title = textView()
        title.becomeFirstResponder()
        try type("s")

        #expect(body.text == "body line two")
        #expect(title.text == "milks")
    }

    @Test("held keys the title never takes become the new note's title")
    func untakenKeysBecomeTheTitle() async throws {
        let body = textView()
        body.becomeFirstResponder()
        var kept: [(String, String)] = []

        let keys = NewNoteKeys(window: window) { kept.append(($0, $1)) }
        try type("eggs")
        window.endEditing(true)
        #expect(kept.isEmpty)
        keys.made("new")
        await Task.yield()

        #expect(kept.map(\.0) == ["new"])
        #expect(kept.map(\.1) == ["eggs"])
        #expect(body.text.isEmpty)
    }

    @Test("a failed create ends the hold and keeps nothing")
    func failedCreateEndsTheHold() throws {
        textView().becomeFirstResponder()

        let keys = NewNoteKeys(window: window) { _, _ in Issue.record("no note was made") }
        try type("x")
        keys.failed()

        #expect(firstResponder(in: window) == nil)
    }

    @Test("a second ⌘N before the first note is made keeps each note's keys apart")
    func secondNewNoteKeepsTheFirstKeys() async throws {
        textView().becomeFirstResponder()
        var kept: [(String, String)] = []

        let first = NewNoteKeys(window: window) { kept.append(($0, $1)) }
        try type("one")
        let second = NewNoteKeys(window: window) { _, _ in Issue.record("the title took the keys") }
        try type("two")
        first.made("first")
        await Task.yield()
        second.made("second")
        let title = textView()
        title.becomeFirstResponder()

        #expect(kept.map(\.0) == ["first"])
        #expect(kept.map(\.1) == ["one"])
        #expect(title.text == "two")
    }
}
