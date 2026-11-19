import MemryCore
import SwiftUI
import Testing
import UIKit
@testable import Memry

/// Body pulls that reach no server and land nothing.
private final class QuietFiller: VaultFilling, @unchecked Sendable {
    func isFirstSyncComplete() async throws -> Bool { true }
    func firstSync(
        progress: @escaping @MainActor @Sendable (SyncProgress) -> Void
    ) async throws -> FirstSyncSummary { .none }
    func pullNoteBody(noteId: String) async throws -> BodyFetchSummary {
        BodyFetchSummary(updates: 0, baselines: 0, stopped: false)
    }
}

@Suite("Line Return")
struct LineReturnTests {
    @Test func keys_after_the_newline_are_held_for_the_body() throws {
        let burst = try #require(LineReturn(previous: "F1", value: "F1 paragraph\nbo"))
        #expect(burst.line == "F1 paragraph")
        #expect(burst.held(in: "F1 paragraph\nbo") == "bo")
        #expect(burst.held(in: "F1 paragraph\nbody") == "body")
    }

    @Test func a_return_inside_the_title_keeps_the_text_after_the_caret() throws {
        let burst = try #require(LineReturn(previous: "F1 paragraph", value: "F1 para\ngraph"))
        #expect(burst.line == "F1 paragraph")
        #expect(burst.held(in: "F1 para\nxygraph") == "xy")
    }

    @Test func a_submitted_return_holds_keys_typed_at_the_caret() {
        let burst = LineReturn(submitted: "F1 paragraph")
        #expect(burst.line == "F1 paragraph")
        #expect(burst.held(in: "F1 paragraphbody") == "body")
        #expect(burst.held(in: "F1 paragraph") == "")
    }

    @Test func an_edit_without_a_newline_is_no_return() {
        #expect(LineReturn(previous: "F1", value: "F1 p") == nil)
    }

    @Test func a_backspace_past_the_return_holds_nothing() throws {
        let burst = try #require(LineReturn(previous: "F1", value: "F1\n"))
        #expect(burst.held(in: "F1") == nil)
    }
}

/// #4774, #4824: on iPad, the notes list moves the keyboard focus to the new
/// note's selected row each time it mirrors its selection, twice or more
/// after New note. These are the focus updates logged on the iPad Air 13
/// simulator with a hardware keyboard.
@Suite("Title focus claim")
struct TitleFocusClaimTests {
    /// Whether a new note's title takes the caret back after each move.
    private func takenBack(_ moves: [TitleFocusMove], claiming: Bool = true) -> [Bool] {
        var claim = TitleFocusClaim()
        if claiming { claim.start() }
        return moves.map { claim.takesBack(after: $0) }
    }

    @Test func every_move_to_the_selected_row_is_taken_back() {
        #expect(takenBack([.toSelectedRow, .intoTitle, .toSelectedRow]) == [true, false, true])
    }

    @Test func the_title_taking_the_caret_again_keeps_the_claim() {
        #expect(takenBack([.toNothing, .intoTitle, .toSelectedRow]) == [false, false, true])
    }

    @Test func a_key_move_ends_the_claim() {
        #expect(takenBack([.byKey, .toSelectedRow]) == [false, false])
    }

    @Test func another_text_field_ends_the_claim() {
        #expect(takenBack([.intoText, .toSelectedRow]) == [false, false])
    }

    @Test func a_menu_or_a_control_keeps_the_focus_and_ends_the_claim() {
        #expect(takenBack([.elsewhere, .toSelectedRow]) == [false, false])
    }

    @Test func a_title_that_claims_nothing_takes_nothing_back() {
        #expect(takenBack([.toSelectedRow], claiming: false) == [false])
    }

    /// The title losing the caret to a move it takes back is no end of the
    /// edit, and its coming back is no new one.
    @Test func a_take_back_keeps_the_edit_going() {
        var claim = TitleFocusClaim()
        claim.start()
        let takenBack = claim.takesBack(after: .toSelectedRow)
        #expect(takenBack && claim.retaking)
        let retaken = claim.retakes(caretInOtherText: false)
        #expect(retaken)
        let cameBack = claim.refocused()
        #expect(cameBack && !claim.retaking)
        let laterFocus = claim.refocused()
        #expect(!laterFocus, "a later focus of the title is a new edit")
    }

    /// The user put the caret in the body before the take-back ran: it
    /// stays there, and the claim ends.
    @Test func a_take_back_leaves_a_caret_the_user_moved_to_a_text_view() {
        var claim = TitleFocusClaim()
        claim.start()
        _ = claim.takesBack(after: .toSelectedRow)
        let retaken = claim.retakes(caretInOtherText: true)
        #expect(!retaken)
        #expect(!claim.holds)
        #expect(!claim.retaking)
    }

    @Test func a_take_back_after_the_claim_ended_takes_nothing() {
        var claim = TitleFocusClaim()
        claim.start()
        _ = claim.takesBack(after: .toSelectedRow)
        claim.end()
        let retaken = claim.retakes(caretInOtherText: false)
        #expect(!retaken)
    }

    /// The title focusing again settles a take-back. Its text view letting
    /// go of the caret as the list takes it is part of the move.
    @Test func a_take_back_is_settled_only_by_the_title_focusing_again() {
        var claim = TitleFocusClaim()
        claim.start()
        _ = claim.takesBack(after: .toSelectedRow)
        _ = claim.takesBack(after: .toNothing)
        #expect(claim.retaking)
        _ = claim.takesBack(after: .intoTitle)
        #expect(!claim.retaking)
        #expect(claim.holds)
    }

    /// UIKit's focus update as a move: a heading is a key's move, except to
    /// nothing.
    @Test func focus_updates_map_to_moves() {
        let cases: [(TitleFocusTarget, Bool, TitleFocusMove)] = [
            (.nothing, false, .toNothing), (.nothing, true, .toNothing),
            (.selectedRow, true, .byKey), (.text, true, .byKey), (.title, true, .byKey),
            (.title, false, .intoTitle), (.text, false, .intoText),
            (.selectedRow, false, .toSelectedRow), (.other, false, .elsewhere),
        ]
        for (target, byKey, move) in cases {
            #expect(TitleFocusMove(to: target, byKey: byKey) == move, "\(target) byKey \(byKey)")
        }
    }
}

/// #4823, #4815: the keys pressed before a Return belong to its line, also
/// the ones the keyboard dropped.
@Suite("Pressed keys")
struct PressedKeysTests {
    /// `presses` go down, a Return goes down after the first `beforeReturn`,
    /// and the keyboard turns `previous` into each of `texts` in turn.
    private func keys(
        _ presses: String, returnAfter beforeReturn: Int, texts: [String], from previous: String = "",
        locale: Locale = Locale(identifier: "en_US")
    ) -> PressedKeys {
        var keys = PressedKeys()
        keys.locale = locale
        for (index, key) in presses.enumerated() {
            if index == beforeReturn { keys.returnPressed() }
            keys.pressed(String(key))
        }
        if beforeReturn == presses.count { keys.returnPressed() }
        var last = previous
        for text in texts {
            keys.changed(from: last, to: text)
            last = text
        }
        return keys
    }

    @Test func keys_that_all_arrived_are_left_alone() {
        let keys = keys("title", returnAfter: 5, texts: ["T", "Ti", "Tit", "Titl", "Title"])
        #expect(keys.restoring("Title", end: 5) == "Title")
    }

    @Test func keys_pressed_before_the_return_that_never_arrived_follow_the_last_that_did() {
        let keys = keys("title", returnAfter: 5, texts: ["T", "Ti", "Tit"])
        #expect(keys.restoring("Tit", end: 3) == "Title")
    }

    @Test func a_key_the_text_skipped_goes_back_in_its_place() {
        let keys = keys("title", returnAfter: 5, texts: ["T", "Ti", "Tit", "Tite"])
        #expect(keys.restoring("Tite", end: 4) == "Title")
    }

    /// Space autocorrects the word before it, and the line keeps the
    /// correction.
    @Test func an_autocorrection_its_key_triggered_stays() {
        let keys = keys("teh x", returnAfter: 5, texts: ["T", "Te", "Teh", "The "])
        #expect(keys.restoring("The ", end: 4) == "The x")
    }

    /// The keyboard autocorrected the part of the word it saw as the Return
    /// made it drop the rest: the keys pressed hold the line.
    @Test func a_rewrite_of_a_word_cut_by_the_return_gives_way_to_the_keys_pressed() {
        let keys = keys("title", returnAfter: 5, texts: ["T", "Ti", "To"])
        #expect(keys.restoring("To", end: 2) == "Title")
    }

    /// A key pressed after the Return that reaches the field before the
    /// Return comes up lands after the keys the rewrite cut, as it does
    /// without a rewrite.
    @Test func a_key_after_a_rewrite_still_lands_in_the_line() {
        let keys = keys("titlea", returnAfter: 5, texts: ["T", "Ti", "To", "Toa"])
        #expect(keys.restoring("Toa", end: 3) == "Titlea")
    }

    /// A Turkish keyboard capitalizes `i` as `İ`.
    @Test func a_key_capitalized_by_the_keyboards_language_is_its_key() {
        let keys = keys("istanbul", returnAfter: 8, texts: ["İ", "İs", "İst"], locale: Locale(identifier: "tr_TR"))
        #expect(keys.restoring("İst", end: 3) == "İstanbul")
    }

    /// The keyboard delivered the keys the line put back after all, into the
    /// field while it holds the keys after the Return: they are counted, so
    /// the field drops them.
    @Test func keys_the_line_put_back_that_arrive_late_are_counted_once() {
        var keys = keys("titlex", returnAfter: 5, texts: ["T", "Ti", "Tit", "Tit\n"])
        #expect(keys.restoring("Tit", end: 3) == "Title")
        keys.handOff()
        keys.changed(from: "Tit\n", to: "Tit\nl")
        keys.changed(from: "Tit\nl", to: "Tit\nle")
        keys.changed(from: "Tit\nle", to: "Tit\nlex")
        let taken = keys.takeLate()
        #expect(taken.arrived == 2)
        #expect(taken.late == nil)
        #expect(LineReturn(previous: "Tit", value: "Tit\n")?.kept(in: "Tit\nlex", dropping: 2) == "Titx")
    }

    @Test func late_keys_wait_only_for_keys_never_pressed_since() {
        var late = LateKeys(keys: ["l", "e"], presses: [], locale: Locale(identifier: "en_US"))
        let l = late.arrived("L")
        #expect(l)
        #expect(late.waiting)
        late.pressed("e")
        let e = late.arrived("e")
        #expect(!e, "a key pressed since the Return is that key")
        #expect(!late.waiting)
        var ended = LateKeys(keys: ["l"], presses: [], locale: Locale(identifier: "en_US"))
        let x = ended.arrived("x")
        let after = ended.arrived("l")
        #expect(!x)
        #expect(!after, "a late key arrives ahead of every other key")
    }

    @Test func keys_pressed_after_the_return_are_not_the_lines() {
        let keys = keys("titleabc", returnAfter: 5, texts: ["T", "Ti", "Tit", "Titl", "Title"])
        #expect(keys.restoring("Title", end: 5) == "Title")
    }

    @Test func the_returns_newline_matches_no_key() {
        let keys = keys("title", returnAfter: 5, texts: ["T", "Ti", "Tit", "Tite", "Tite\n"])
        #expect(keys.restoring("Tite\n", end: 4) == "Title\n")
    }

    @Test func keys_typed_into_the_middle_go_back_there() {
        let keys = keys("ab", returnAfter: 2, texts: ["Faoo"], from: "Foo")
        #expect(keys.restoring("Faoo", end: 4) == "Faboo")
    }

    @Test func an_edit_the_presses_cannot_explain_puts_nothing_back() {
        // Backspace.
        var deleted = keys("tit", returnAfter: 3, texts: ["T", "Ti"])
        deleted.pressed("\u{7F}")
        deleted.changed(from: "Ti", to: "T")
        #expect(deleted.restoring("T", end: 1) == "T")
        // A key with no text of its own, an arrow.
        var moved = keys("tit", returnAfter: 3, texts: ["T"])
        moved.pressed("\u{F702}")
        #expect(moved.restoring("T", end: 1) == "T")
        // Text no key typed, such as a paste.
        let pasted = keys("ab", returnAfter: 2, texts: ["xy"])
        #expect(pasted.restoring("xy", end: 2) == "xy")
        // A skip of a key pressed after the Return.
        let early = keys("ab", returnAfter: 0, texts: ["b"])
        #expect(early.restoring("b", end: 1) == "b")
    }
}

/// #4705: keys typed into a note's title as one burst, the way a hardware
/// keyboard or a text expander delivers them, before the page draws again.
@Suite("Note title bursts", .serialized)
@MainActor
struct NoteTitleBurstTests {
    private struct Fixture {
        let vault: TasksTestVault
        let noteId: String
        let reader: CoreNotesReader
    }

    private func fixture() throws -> Fixture {
        let vault = try TasksTestVault()
        let noteId = try vault.vault.notesWriter(store: TaskTestKeychain()).create(title: "", folderPath: nil)
        return Fixture(vault: vault, noteId: noteId, reader: CoreNotesReader(vault: vault.vault, executor: .shared))
    }

    /// A new note as the app makes it, on one empty paragraph.
    private func newNote() async throws -> Fixture {
        let vault = try TasksTestVault()
        let noteId = try await CoreNotesWriter(vault: vault.vault, store: TaskTestKeychain(), executor: .shared)
            .create(title: "", folderPath: nil)
        return Fixture(vault: vault, noteId: noteId, reader: CoreNotesReader(vault: vault.vault, executor: .shared))
    }

    /// Opens the new note's page in a scene window; its title takes the caret.
    private func open(_ f: Fixture) async throws -> (UIWindow, UITextView) {
        let scene = try #require(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let window = UIWindow(windowScene: scene)
        let writer = CoreNoteMetadataWriter(vault: f.vault.vault, store: TaskTestKeychain(), executor: .shared)
        window.rootViewController = UIHostingController(rootView: NoteReadView(
            route: NoteRoute(id: f.noteId), reader: f.reader, filler: QuietFiller(),
            editor: CoreBlockEditor(vault: f.vault.vault, store: TaskTestKeychain(), executor: .shared),
            metadataWriter: writer
        ))
        window.makeKeyAndVisible()
        await until { title(in: window)?.isFirstResponder == true }
        let field = try #require(title(in: window), "the title field was not drawn")
        #expect(field.isFirstResponder, "a new note's title did not take the caret")
        // The page's focus state follows the responder a turn later.
        try await settle(f)
        return (window, field)
    }

    private func views<T: UIView>(_ type: T.Type, in window: UIWindow) -> [T] {
        func all(_ view: UIView) -> [T] { ((view as? T).map { [$0] } ?? []) + view.subviews.flatMap(all) }
        return window.rootViewController?.view.map(all) ?? []
    }

    /// The title field: the one text view that is not a block.
    private func title(in window: UIWindow) -> UITextView? {
        views(UITextView.self, in: window).first { !($0 is BlockTextView) }
    }

    private func until(_ condition: () -> Bool) async {
        for _ in 0..<300 where !condition() {
            try? await Task.sleep(for: .milliseconds(20))
        }
    }

    private func settle(_ f: Fixture) async throws {
        for _ in 0..<10 {
            _ = try await f.reader.read(id: f.noteId)
            await Task.yield()
        }
    }

    private func stored(_ f: Fixture) async throws -> (title: String?, body: [String]) {
        let detail = try await f.reader.read(id: f.noteId)
        let blocks = try await f.reader.blocks(id: f.noteId) ?? []
        return (detail?.summary.title, blocks.map { $0.inline.map(\.text).joined() })
    }

    /// Waits for the stored title and body to be `title` and `body`.
    private func expectStored(_ f: Fixture, title: String, body: [String]) async throws {
        for _ in 0..<300 {
            let now = try await stored(f)
            if now.title == title, now.body == body { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        let now = try await stored(f)
        #expect(now.title == title, "\(now)")
        #expect(now.body == body, "\(now)")
    }

    /// The body's first block has the caret and the keys typed after the
    /// title's Return; once it lets go, the note stores both.
    private func expectBody(in window: UIWindow, _ f: Fixture) async throws {
        await until { views(BlockTextView.self, in: window).first?.text == "body" }
        let block = try #require(views(BlockTextView.self, in: window).first, "the body has no block")
        #expect(block.isFirstResponder, "Return left the caret in the title")
        #expect(block.text == "body")
        block.resignFirstResponder()
        try await expectStored(f, title: "F1 paragraph", body: ["body"])
    }

    @Test(.timeLimit(.minutes(1))) func keys_typed_after_the_titles_return_land_in_the_body() async throws {
        let f = try fixture()
        let (window, field) = try await open(f)
        defer { window.isHidden = true }

        for key in "F1 paragraph\nbody" { field.insertText(String(key)) }

        try await expectBody(in: window, f)
        #expect(field.text == "F1 paragraph")
    }

    /// The edit ended while the title kept the caret, as when the app
    /// resumes: the next keys still land, and Return still moves to the body.
    @Test(.timeLimit(.minutes(1))) func keys_after_an_edit_ended_under_the_caret_land() async throws {
        let f = try fixture()
        let (window, field) = try await open(f)
        defer { window.isHidden = true }

        for key in "F1 par" { field.insertText(String(key)) }
        field.resignFirstResponder()
        field.becomeFirstResponder()
        for key in "agraph\nbody" { field.insertText(String(key)) }

        try await expectBody(in: window, f)
    }

    /// A key as the keyboard delivers it: to the text view that has the
    /// caret, through its delegate as UIKit asks it (the ranges form where
    /// the delegate has it, as the title's does). With no text view holding
    /// the caret the key reaches nothing, as on a device.
    private func key(_ key: String, in window: UIWindow, title: UITextView) {
        guard let view = title.isFirstResponder ? title : views(BlockTextView.self, in: window).first(where: \.isFirstResponder)
        else { return }
        let ranges = [NSValue(range: view.selectedRange)]
        let allowed = view.delegate?.textView?(view, shouldChangeTextInRanges: ranges, replacementText: key)
            ?? view.delegate?.textView?(view, shouldChangeTextIn: view.selectedRange, replacementText: key)
        if allowed != false { view.insertText(key) }
    }

    /// #4756: `title⏎[] milk` typed as a hardware burst. The Return is the
    /// hardware key, which the title's text view takes as a press (a submit,
    /// #4705) rather than as text; the keys after it arrive `gap` run-loop
    /// turns apart while the body's row is drawn and takes the caret. Every
    /// key lands once, in order: the title gave up the caret as Return
    /// submitted it, before the body took it, and the keys typed meanwhile
    /// reached no text view (`] milk`, the `[` lost).
    @Test(.timeLimit(.minutes(2)), arguments: [0, 1, 3, 100])
    func a_burst_through_the_titles_return_key_into_a_checklist_keeps_every_key(gap: Int) async throws {
        try await expectChecklistBurst(gap: gap)
    }

    /// The keyboard queues keys, and the Return's press arrives ahead of
    /// keys typed before it that it still queues: `le` reaches the title
    /// after the Return went down. A hand-off as the key went down saved
    /// `tit` and moved `le` to the body.
    @Test(.timeLimit(.minutes(2)), arguments: [0, 3])
    func keys_typed_before_the_return_but_inserted_after_its_press_stay_in_the_title(gap: Int) async throws {
        try await expectChecklistBurst(late: "le", gap: gap)
    }

    /// The keyboard may insert the Return's newline, in its place among the
    /// keys, before the key comes up: the newline hands off, and the key-up
    /// ends the editing of every text view. The body keeps the caret, and
    /// the keys after the Return land in it.
    @Test(.timeLimit(.minutes(2)), arguments: [0, 3])
    func a_return_whose_newline_arrives_before_its_key_up_keeps_the_caret_in_the_body(gap: Int) async throws {
        try await expectChecklistBurst(newline: true, gap: gap)
    }

    /// #4823: a Return held as long as a real keypress. The keyboard drops
    /// the keys it still queues as the Return goes down: `le`, pressed
    /// before it, never reaches the title, which stored `tit`.
    @Test(.timeLimit(.minutes(2)), arguments: [0, 3])
    func keys_pressed_before_a_held_return_that_the_keyboard_drops_stay_in_the_title(gap: Int) async throws {
        try await expectChecklistBurst(late: "le", delivered: "", gap: gap)
    }

    /// #4815: the keyboard drops one queued key as the Return goes down and
    /// inserts the next: `e` arrives without `l`, which stored `tite`.
    @Test(.timeLimit(.minutes(2)), arguments: [0, 3])
    func a_key_the_keyboard_skips_at_the_returns_press_goes_back_in_its_place(gap: Int) async throws {
        try await expectChecklistBurst(late: "le", delivered: "e", gap: gap)
    }

    /// The same skipped key, with the Return's newline inserted before its
    /// key-up: the newline's hand-off puts it back too.
    @Test(.timeLimit(.minutes(2)), arguments: [0, 3])
    func a_key_skipped_before_the_returns_newline_goes_back_in_its_place(gap: Int) async throws {
        try await expectChecklistBurst(late: "le", delivered: "e", newline: true, gap: gap)
    }

    /// Types `title⏎[] milk` through the hardware Return, with the `late`
    /// tail of `title` reaching the title after the Return went down, and
    /// with the Return's newline inserted before it comes up when `newline`.
    /// With `delivered`, the page's key handlers hear every key of `title`
    /// go down first, as from a keyboard, and the keyboard inserts only
    /// `delivered` of `late`. Expects `title` stored over a `milk` checklist
    /// item.
    private func expectChecklistBurst(
        late: String = "", delivered: String? = nil, newline: Bool = false, gap: Int
    ) async throws {
        let seen = try await uninterrupted { f, window, field in
            if delivered != nil {
                for character in "title" { field.next?.pressesBegan([HardwarePress(character)], with: nil) }
            }
            for character in "title".dropLast(late.count) { key(String(character), in: window, title: field) }
            let press = HardwarePress(.keyboardReturnOrEnter, "\r")
            // The page's key handlers hear the press as it goes down, ahead
            // of the keys the keyboard still queues; the text view takes it
            // in its place in that queue, after `late`.
            if !late.isEmpty { field.next?.pressesBegan([press], with: nil) }
            for character in delivered ?? late { key(String(character), in: window, title: field) }
            // The newline lands ahead of the key-up. The text view takes no
            // insert from a test while it holds a press.
            if newline { key("\n", in: window, title: field) }
            field.pressesBegan([press], with: nil)
            field.pressesEnded([press], with: nil)
            for character in "[] milk" {
                for _ in 0 ..< gap { try await Task.sleep(for: .milliseconds(1)) }
                key(String(character), in: window, title: field)
            }

            await until { views(BlockTextView.self, in: window).first?.text == "milk" }
            let block = views(BlockTextView.self, in: window).first
            let body = block?.text
            let shown = field.text
            await until { field.text == "title" }
            let title = field.text
            block?.resignFirstResponder()
            for _ in 0..<300 {
                let now = try await stored(f)
                if now.title == "title", now.body == ["milk"] { break }
                try await Task.sleep(for: .milliseconds(20))
            }
            let kinds = try await f.reader.blocks(id: f.noteId)?.map(\.kind)
            return (body, shown, title, try await stored(f), kinds)
        }
        #expect(seen.0 == "milk", "the body shows \(seen.0 ?? "nil")")
        #expect(seen.2 == "title", "the title shows \(seen.2 ?? "nil"), at first \(seen.1 ?? "nil")")
        #expect(seen.3.title == "title", "\(seen.3)")
        #expect(seen.3.body == ["milk"], "\(seen.3)")
        #expect(seen.4 == ["checkListItem"], "\(seen.4 ?? [])")
    }

    /// #4823: the keyboard delivers `le`, which the title's line put back,
    /// late into the body after the hand-off: the body drops them, as the
    /// title has them. Keys the body heard pressed are the user's, typed
    /// again: those stay.
    @Test(.timeLimit(.minutes(2)), arguments: [false, true])
    func keys_the_titles_line_put_back_reach_the_note_once(pressedInBody: Bool) async throws {
        let seen = try await uninterrupted { f, window, field in
            for character in "title" { field.next?.pressesBegan([HardwarePress(character)], with: nil) }
            for character in "tit" { key(String(character), in: window, title: field) }
            let press = HardwarePress(.keyboardReturnOrEnter, "\r")
            field.next?.pressesBegan([press], with: nil)
            field.pressesBegan([press], with: nil)
            field.pressesEnded([press], with: nil)
            await until { views(BlockTextView.self, in: window).first?.isFirstResponder == true }
            let block = views(BlockTextView.self, in: window).first
            for character in "lex" {
                if pressedInBody { block?.keyWentDown?(String(character)) }
                key(String(character), in: window, title: field)
            }
            let body = block?.text
            block?.resignFirstResponder()
            let expected = pressedInBody ? ["lex"] : ["x"]
            for _ in 0..<300 {
                let now = try await stored(f)
                if now.title == "title", now.body == expected { break }
                try await Task.sleep(for: .milliseconds(20))
            }
            return (body, try await stored(f))
        }
        let expected = pressedInBody ? "lex" : "x"
        #expect(seen.0 == expected, "the body shows \(seen.0 ?? "nil")")
        #expect(seen.1.title == "title", "\(seen.1)")
        #expect(seen.1.body == [expected], "\(seen.1)")
    }

    /// Runs `scenario` on a new note until no other suite made its window
    /// key meanwhile, and returns what it saw. Suites run in parallel in this
    /// process, and a window made key elsewhere takes the caret mid-burst:
    /// such a run proves nothing either way (as in `EditorReturnBurstTests`).
    private func uninterrupted<T>(_ scenario: (Fixture, UIWindow, UITextView) async throws -> T) async throws -> T {
        var attempt = 0
        while true {
            attempt += 1
            let f = try await newNote()
            let (window, field) = try await open(f)
            let resigned = Resigned(window)
            let seen = try await scenario(f, window, field)
            resigned.stop()
            window.isHidden = true
            if !resigned.happened || attempt == 10 { return seen }
            try await Task.sleep(for: .milliseconds(200 * attempt))
        }
    }

    /// #4756: a hardware Return while an input method composes in the title
    /// is the composition's, not the move to the body. The caret stays in
    /// the title, and the next key lands there: SwiftUI ends the field's
    /// editing as the key comes up, and the key typed then reached no text
    /// view.
    @Test(.timeLimit(.minutes(1))) func a_return_key_during_a_composition_stays_in_the_title() async throws {
        let f = try await newNote()
        let (window, field) = try await open(f)
        defer { window.isHidden = true }

        for character in "title" { key(String(character), in: window, title: field) }
        field.setMarkedText("か", selectedRange: NSRange(location: 1, length: 0))
        let press = HardwarePress(.keyboardReturnOrEnter, "\r")
        field.pressesBegan([press], with: nil)
        // The input method confirms its composition on the key going down.
        field.unmarkText()
        field.pressesEnded([press], with: nil)
        try await settle(f)

        #expect(views(BlockTextView.self, in: window).allSatisfy { !$0.isFirstResponder }, "the body took the caret")
        #expect(field.isFirstResponder, "the title lost the caret to no text view")
        key("x", in: window, title: field)
        try await settle(f)
        #expect(field.text == "titleかx")

        // The next Return, with nothing composing, moves to the body.
        field.pressesBegan([press], with: nil)
        field.pressesEnded([press], with: nil)
        await until { views(BlockTextView.self, in: window).first?.isFirstResponder == true }
        #expect(views(BlockTextView.self, in: window).first?.isFirstResponder == true, "the plain Return stayed in the title")
        try await expectTitle(f, "titleかx")
    }

    /// Romaji typed fast and then Return: the page's key handlers hear the
    /// press go down before the queued keys compose `か` in the title, and
    /// the input method takes the Return as it reaches the text view, to
    /// confirm. The caret stays in the title with `か`.
    @Test(.timeLimit(.minutes(1))) func a_return_confirming_a_composition_still_queued_at_its_press_stays_in_the_title() async throws {
        let f = try await newNote()
        let (window, field) = try await open(f)
        defer { window.isHidden = true }

        for character in "title" { key(String(character), in: window, title: field) }
        let press = HardwarePress(.keyboardReturnOrEnter, "\r")
        field.next?.pressesBegan([press], with: nil)
        field.setMarkedText("か", selectedRange: NSRange(location: 1, length: 0))
        field.pressesBegan([press], with: nil)
        field.unmarkText()
        field.pressesEnded([press], with: nil)
        try await settle(f)

        #expect(views(BlockTextView.self, in: window).allSatisfy { !$0.isFirstResponder }, "the body took the caret")
        #expect(field.isFirstResponder, "the title lost the caret")
        key("x", in: window, title: field)
        try await settle(f)
        #expect(field.text == "titleかx")
    }

    /// A composition deleted with Backspace is over: the next Return is a
    /// plain one, saves the title and moves to the body, and the keys after
    /// it land there.
    @Test(.timeLimit(.minutes(1))) func a_return_after_a_deleted_composition_moves_to_the_body() async throws {
        let f = try await newNote()
        let (window, field) = try await open(f)
        defer { window.isHidden = true }

        for character in "title" { key(String(character), in: window, title: field) }
        field.setMarkedText("き", selectedRange: NSRange(location: 1, length: 0))
        try await settle(f)
        // Backspace empties the composition, and the input method ends it.
        field.setMarkedText("", selectedRange: NSRange(location: 0, length: 0))
        field.unmarkText()
        try await settle(f)
        #expect(field.text == "title")

        let press = HardwarePress(.keyboardReturnOrEnter, "\r")
        field.pressesBegan([press], with: nil)
        field.pressesEnded([press], with: nil)
        await until { views(BlockTextView.self, in: window).first?.isFirstResponder == true }
        #expect(views(BlockTextView.self, in: window).first?.isFirstResponder == true, "the Return stayed in the title")
        for character in "mi" { key(String(character), in: window, title: field) }
        await until { views(BlockTextView.self, in: window).first?.text == "mi" }
        #expect(field.text == "title")
        views(BlockTextView.self, in: window).first?.resignFirstResponder()
        try await expectStored(f, title: "title", body: ["mi"])
    }

    /// A Return press cancelled while an input method composes leaves no
    /// claim on the caret: dismissing the keyboard afterwards ends the
    /// title's edit and saves it.
    @Test(.timeLimit(.minutes(1))) func a_cancelled_return_during_a_composition_leaves_no_claim_on_the_caret() async throws {
        let f = try await newNote()
        let (window, field) = try await open(f)
        defer { window.isHidden = true }

        for character in "title" { key(String(character), in: window, title: field) }
        field.setMarkedText("か", selectedRange: NSRange(location: 1, length: 0))
        let press = HardwarePress(.keyboardReturnOrEnter, "\r")
        field.pressesBegan([press], with: nil)
        field.pressesCancelled([press], with: nil)
        field.unmarkText()
        try await settle(f)
        #expect(field.isFirstResponder)

        field.resignFirstResponder()
        try await settle(f)
        #expect(!field.isFirstResponder, "the title took the caret back")
        try await expectTitle(f, "titleか")
    }

    /// A cancelled Return press is no Return: the caret stays in the title,
    /// the next key lands there, and the next Return moves to the body.
    @Test(.timeLimit(.minutes(1))) func a_cancelled_return_press_keeps_the_caret_in_the_title() async throws {
        let f = try await newNote()
        let (window, field) = try await open(f)
        defer { window.isHidden = true }

        for character in "title" { key(String(character), in: window, title: field) }
        // The page's key handlers hear the press go down and be cancelled.
        let press = HardwarePress(.keyboardReturnOrEnter, "\r")
        field.next?.pressesBegan([press], with: nil)
        field.next?.pressesCancelled([press], with: nil)
        try await settle(f)
        #expect(field.isFirstResponder, "the cancelled Return moved the caret")
        key("x", in: window, title: field)
        try await settle(f)
        #expect(field.text == "titlex")

        field.pressesBegan([press], with: nil)
        field.pressesEnded([press], with: nil)
        await until { views(BlockTextView.self, in: window).first?.isFirstResponder == true }
        #expect(views(BlockTextView.self, in: window).first?.isFirstResponder == true, "the Return stayed in the title")
        try await expectTitle(f, "titlex")
    }

    /// #4722: keys typed slowly into the block the title's Return moved the
    /// caret to are stored as the app leaves, with the block still focused.
    @Test(.timeLimit(.minutes(1))) func leaving_the_app_stores_the_keys_typed_after_the_titles_return() async throws {
        let f = try fixture()
        let (window, field) = try await open(f)
        defer { window.isHidden = true }

        for key in "F1 paragraph\n" { field.insertText(String(key)) }
        await until { views(BlockTextView.self, in: window).first?.isFirstResponder == true }
        let block = try #require(views(BlockTextView.self, in: window).first, "the body has no block")
        try await settle(f)
        for key in "body" {
            if block.delegate?.textView?(block, shouldChangeTextIn: block.selectedRange, replacementText: String(key)) != false {
                block.insertText(String(key))
            }
        }
        NotificationCenter.default.post(name: UIApplication.willResignActiveNotification, object: nil)

        try await expectStored(f, title: "F1 paragraph", body: ["body"])
        #expect(block.isFirstResponder, "the block kept the caret: only leaving the app committed it")
    }

    /// Waits for the stored title to be `title`.
    private func expectTitle(_ f: Fixture, _ title: String) async throws {
        for _ in 0..<300 where try await stored(f).title != title {
            try await Task.sleep(for: .milliseconds(20))
        }
        #expect(try await stored(f).title == title)
    }

    /// #4776: a title typed without Return is stored as the app leaves, with
    /// the title still focused, so a kill from the background keeps it.
    @Test(.timeLimit(.minutes(1))) func leaving_the_app_stores_a_title_typed_without_return() async throws {
        let f = try fixture()
        let (window, field) = try await open(f)
        defer { window.isHidden = true }

        for key in "Title" { field.insertText(String(key)) }
        try await settle(f)
        NotificationCenter.default.post(name: UIApplication.willResignActiveNotification, object: nil)

        try await expectTitle(f, "Title")
        #expect(field.isFirstResponder, "the title kept the caret: only leaving the app saved it")
        #expect(field.text == "Title")

        // Typing on after coming back saves again as the edit ends.
        for key in " two" { field.insertText(String(key)) }
        try await settle(f)
        field.resignFirstResponder()
        try await expectTitle(f, "Title two")
    }

    /// #4776: an input method's composition is not saved half-composed as
    /// the app resigns (Control Center keeps it open); going to the
    /// background ends it and saves the title with its text.
    @Test(.timeLimit(.minutes(1))) func a_composing_title_is_saved_once_the_app_goes_to_the_background() async throws {
        let f = try fixture()
        let (window, field) = try await open(f)
        defer { window.isHidden = true }

        for key in "Foo" { field.insertText(String(key)) }
        field.setMarkedText("k", selectedRange: NSRange(location: 1, length: 0))
        try await settle(f)
        NotificationCenter.default.post(name: UIApplication.willResignActiveNotification, object: nil)
        try await settle(f)
        #expect(field.markedTextRange != nil, "resigning ended the composition")
        #expect(try await stored(f).title == "", "a half-composed title was saved")

        NotificationCenter.default.post(name: UIApplication.didEnterBackgroundNotification, object: nil)

        try await expectTitle(f, "Fook")
        #expect(field.markedTextRange == nil)
        #expect(field.text == "Fook")
    }

    /// The iPad notes list moving the focus from the title to its selected
    /// row, as UIKit reports it, and the title's text view letting go.
    private func listSteals(from field: UITextView, in window: UIWindow) {
        let row = UICollectionViewCell()
        row.isSelected = true
        NotificationCenter.default.post(
            name: UIFocusSystem.didUpdateNotification, object: UIFocusSystem.focusSystem(for: window),
            userInfo: [UIFocusSystem.focusUpdateContextUserInfoKey: FocusUpdate.make(previous: field, next: row)]
        )
        field.resignFirstResponder()
    }

    /// #4824 review: the list took the caret after `tit` and the title took
    /// it back. A take-back used to end the edit, saving `tit` as the rename
    /// went on, and start another from the stored title, still empty: `le`
    /// was written over `tit`.
    @Test(.timeLimit(.minutes(1))) func keys_typed_after_a_take_back_keep_the_title_typed_before_it() async throws {
        let f = try fixture()
        let (window, field) = try await open(f)
        defer { window.isHidden = true }

        for key in "tit" { field.insertText(String(key)) }
        listSteals(from: field, in: window)
        await until { field.isFirstResponder }
        #expect(field.isFirstResponder, "the title did not take the caret back")
        #expect(try await stored(f).title == "", "the take-back saved the title as an end of the edit")
        for key in "le" { field.insertText(String(key)) }
        #expect(field.text == "title")

        field.resignFirstResponder()
        try await expectTitle(f, "title")
    }

    /// #4824 review: the user put the caret in the body before the take-back
    /// ran. It stays in the body, and the title typed so far is saved.
    @Test(.timeLimit(.minutes(1))) func a_take_back_leaves_the_caret_the_user_put_in_the_body() async throws {
        let f = try await newNote()
        let (window, field) = try await open(f)
        defer { window.isHidden = true }

        for key in "tit" { field.insertText(String(key)) }
        let block = try #require(views(BlockTextView.self, in: window).first, "the body has no block")
        listSteals(from: field, in: window)
        block.becomeFirstResponder()
        try await settle(f)

        #expect(block.isFirstResponder, "the take-back pulled the caret out of the body")
        #expect(!field.isFirstResponder)
        try await expectTitle(f, "tit")
    }

    /// #5081 over #5083: the list took the caret mid-burst, after `title`
    /// went down and only `tit` arrived, and the title took it back. Then a
    /// held Return dropped `le`. The take-back keeps the presses, so the
    /// line puts `le` back, and `le` delivered late into the body is
    /// dropped there: no key is lost or typed twice.
    @Test(.timeLimit(.minutes(2)), arguments: [false, true])
    func a_steal_mid_burst_then_return_keeps_every_key_once(lateIntoBody: Bool) async throws {
        let seen = try await uninterrupted { f, window, field in
            for character in "title" { field.next?.pressesBegan([HardwarePress(character)], with: nil) }
            for character in "tit" { key(String(character), in: window, title: field) }
            listSteals(from: field, in: window)
            await until { field.isFirstResponder }
            let press = HardwarePress(.keyboardReturnOrEnter, "\r")
            field.next?.pressesBegan([press], with: nil)
            field.pressesBegan([press], with: nil)
            field.pressesEnded([press], with: nil)
            await until { views(BlockTextView.self, in: window).first?.isFirstResponder == true }
            let block = views(BlockTextView.self, in: window).first
            for character in (lateIntoBody ? "le" : "") + "body" { key(String(character), in: window, title: field) }
            let body = block?.text
            block?.resignFirstResponder()
            for _ in 0..<300 {
                let now = try await stored(f)
                if now.title == "title", now.body == ["body"] { break }
                try await Task.sleep(for: .milliseconds(20))
            }
            return (body, try await stored(f))
        }
        #expect(seen.0 == "body", "the body shows \(seen.0 ?? "nil")")
        #expect(seen.1.title == "title", "\(seen.1)")
        #expect(seen.1.body == ["body"], "\(seen.1)")
    }
}

/// A focus update as UIKit hands it to the notification's observers.
/// Made without `init`, which asks the screen for its focus system and
/// throws in a test host; the moves live in the class, one at a time.
@MainActor
private final class FocusUpdate: UIFocusUpdateContext {
    private static var previous: UIFocusItem?
    private static var next: UIFocusItem?

    static func make(previous: UIFocusItem?, next: UIFocusItem?) -> UIFocusUpdateContext {
        Self.previous = previous
        Self.next = next
        return class_createInstance(FocusUpdate.self, 0) as! FocusUpdate
    }

    override var previouslyFocusedItem: UIFocusItem? { MainActor.assumeIsolated { Self.previous } }
    override var nextFocusedItem: UIFocusItem? { MainActor.assumeIsolated { Self.next } }
    override var focusHeading: UIFocusHeading { [] }
}

/// A hardware key press, as a keyboard delivers it to the first responder's
/// `pressesBegan`.
private final class HardwarePress: UIPress {
    private let hardwareKey: UIKey

    init(_ code: UIKeyboardHIDUsage, _ characters: String) {
        hardwareKey = HardwareKey(code, characters)
        super.init()
    }

    /// The key of a lowercase ASCII letter.
    convenience init(_ letter: Character) {
        let code = UIKeyboardHIDUsage(rawValue: UIKeyboardHIDUsage.keyboardA.rawValue + Int(letter.asciiValue! - 97))!
        self.init(code, String(letter))
    }

    override var key: UIKey? { hardwareKey }
    override var phase: UIPress.Phase { .began }
}

private final class HardwareKey: UIKey {
    private let code: UIKeyboardHIDUsage
    private let text: String

    init(_ code: UIKeyboardHIDUsage, _ text: String) {
        self.code = code
        self.text = text
        super.init()
    }

    required init?(coder: NSCoder) { nil }

    override var keyCode: UIKeyboardHIDUsage { code }
    override var characters: String { text }
    override var charactersIgnoringModifiers: String { text }
    override var modifierFlags: UIKeyModifierFlags { [] }
}

/// Whether `window` stopped being the key window while watched.
@MainActor
private final class Resigned {
    private(set) var happened = false
    private var observer: NSObjectProtocol?

    init(_ window: UIWindow) {
        observer = NotificationCenter.default.addObserver(
            forName: UIWindow.didResignKeyNotification, object: window, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.happened = true }
        }
    }

    func stop() {
        observer.map(NotificationCenter.default.removeObserver)
        observer = nil
    }
}
