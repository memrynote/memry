import MemryCore
import SwiftUI
import Testing
import UIKit
@testable import Memry

/// #4781: an empty day's first line typed without Return, on a real day page
/// in a scene window, as the app resigns and goes to the background. iOS may
/// end a backgrounded app before the field loses the caret.
@MainActor
@Suite("Journal first line leaving the app", .serialized)
struct JournalFirstLineLeavingTests {
    private struct Fixture {
        let vault: JournalTestVault
        let page: JournalDayPageModel
        let window: UIWindow
    }

    /// Where the page hears the app leave. The app-wide center would reach
    /// every editor of every suite running in parallel (#5780).
    private let notifications = NotificationCenter()

    /// Opens today's empty page and puts the caret in its first line.
    private func open() async throws -> (Fixture, UITextView) {
        let vault = try JournalTestVault()
        let context = JournalVaultContext(
            reader: CoreNotesReader(vault: vault.vault, executor: CoreExecutor()),
            filler: nil, writer: nil, editor: nil, metadataWriter: nil, search: nil, noteTasks: nil
        )
        vault.store.context = context
        await vault.store.loadDay(JournalTestVault.today)
        let page = JournalDayPageModel(
            store: vault.store, date: JournalTestVault.today, context: context, notifications: notifications
        )
        let scene = try #require(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let window = UIWindow(windowScene: scene)
        window.rootViewController = UIHostingController(rootView: JournalDayPage(
            store: vault.store, date: JournalTestVault.today, model: page, isShown: true, open: { _ in },
            titleCollapsed: .constant(false), fog: .constant(nil)
        ))
        window.makeKeyAndVisible()
        await until { firstLine(in: window) != nil }
        let field = try #require(firstLine(in: window), "the empty day drew no first line")
        field.becomeFirstResponder()
        await until { field.isFirstResponder }
        await settle()
        return (Fixture(vault: vault, page: page, window: window), field)
    }

    private func views<T: UIView>(_ type: T.Type, in window: UIWindow) -> [T] {
        func all(_ view: UIView) -> [T] { ((view as? T).map { [$0] } ?? []) + view.subviews.flatMap(all) }
        return window.rootViewController?.view.map(all) ?? []
    }

    /// The first line: the one text view that is not a block.
    private func firstLine(in window: UIWindow) -> UITextView? {
        views(UITextView.self, in: window).first { !($0 is BlockTextView) }
    }

    private func until(_ condition: () -> Bool) async {
        for _ in 0..<300 where !condition() {
            try? await Task.sleep(for: .milliseconds(20))
        }
    }

    /// Lets SwiftUI pass the typed keys to the field's binding.
    private func settle() async {
        for _ in 0..<10 {
            try? await Task.sleep(for: .milliseconds(10))
            await Task.yield()
        }
    }

    private func stored(_ day: Fixture) async -> [String] {
        let blocks = (try? await day.page.bridge.blocks(id: day.page.read.route.id)) ?? []
        return blocks.map { $0.inline.map(\.text).joined() }
    }

    private func expectStored(_ day: Fixture, _ body: [String]) async {
        for _ in 0..<300 where await stored(day) != body {
            try? await Task.sleep(for: .milliseconds(20))
        }
        #expect(await stored(day) == body)
    }

    @Test(.timeLimit(.minutes(1))) func leaving_the_app_lands_a_line_typed_without_return() async throws {
        let (day, field) = try await open()
        defer { day.window.isHidden = true }

        for key in "hello" { field.insertText(String(key)) }
        await settle()
        notifications.post(name: UIApplication.willResignActiveNotification, object: nil)

        await expectStored(day, ["hello"])
        // The line's block takes the caret, as after a Return: the keyboard
        // stays up, and typing goes on in the block on coming back.
        await until { views(BlockTextView.self, in: day.window).first?.isFirstResponder == true }
        let block = try #require(views(BlockTextView.self, in: day.window).first, "the line was drawn as no block")
        #expect(block.isFirstResponder, "the caret left the line as the app resigned")
        #expect(block.text == "hello")
        #expect(firstLine(in: day.window) == nil, "the first line stayed after its line landed")

        await settle()
        let accepts = { (key: String) in
            block.delegate?.textView?(block, shouldChangeTextIn: block.selectedRange, replacementText: key) != false
        }
        for key in " more" where accepts(String(key)) {
            block.insertText(String(key))
        }
        notifications.post(name: UIApplication.willResignActiveNotification, object: nil)
        await expectStored(day, ["hello more"])
    }

    /// An input method's composition is not landed half-made as the app
    /// resigns (Control Center resigns it too); going to the background ends
    /// it as it stands and lands the line.
    @Test(.timeLimit(.minutes(1))) func a_composing_line_lands_once_the_app_goes_to_the_background() async throws {
        let (day, field) = try await open()
        defer { day.window.isHidden = true }

        for key in "Foo" { field.insertText(String(key)) }
        field.setMarkedText("k", selectedRange: NSRange(location: 1, length: 0))
        await settle()
        notifications.post(name: UIApplication.willResignActiveNotification, object: nil)
        await settle()
        #expect(field.markedTextRange != nil, "resigning ended the composition")
        #expect(await stored(day).isEmpty, "a half-composed line landed")

        notifications.post(name: UIApplication.didEnterBackgroundNotification, object: nil)

        await expectStored(day, ["Fook"])
    }

    /// #5820: an iPad window going to the background while others stay
    /// posts only its scene's notification, which lands the composing line.
    @Test(.timeLimit(.minutes(1))) func a_composing_line_lands_once_its_window_goes_to_the_background() async throws {
        let (day, field) = try await open()
        defer { day.window.isHidden = true }

        for key in "Foo" { field.insertText(String(key)) }
        field.setMarkedText("k", selectedRange: NSRange(location: 1, length: 0))
        await settle()
        // A test host has one scene: no scene stands for another window's.
        notifications.post(name: UIScene.didEnterBackgroundNotification, object: nil)
        await settle()
        #expect(await stored(day).isEmpty, "another window landed the line")

        notifications.post(name: UIScene.didEnterBackgroundNotification, object: day.window.windowScene)

        await expectStored(day, ["Fook"])
    }

    /// Each first line ends only its own composition: one that kept a line
    /// after a failed write lands that line, not the other day's text. Both
    /// orders, as the fields hear the notification in an order of their own.
    @Test(.timeLimit(.minutes(1)), arguments: [false, true])
    func a_first_line_without_the_caret_lands_its_own_line(keptBelow: Bool) async throws {
        var written: [String] = []
        var failsFirst = true
        let scene = try #require(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let window = UIWindow(windowScene: scene)
        defer { window.isHidden = true }
        window.rootViewController = UIHostingController(rootView: VStack {
            JournalDayFirstLine(placeholder: "one") { line, _ in
                if failsFirst, !keptBelow { failsFirst = false; return false }
                written.append(line)
                return true
            }
            JournalDayFirstLine(placeholder: "two") { line, _ in
                if failsFirst, keptBelow { failsFirst = false; return false }
                written.append(line)
                return true
            }
        }
        .environment(\.appLifecycle, notifications))
        window.makeKeyAndVisible()
        await until { views(UITextView.self, in: window).count == 2 }
        let fields = views(UITextView.self, in: window)
            .sorted { $0.convert($0.bounds, to: nil).minY < $1.convert($1.bounds, to: nil).minY }
        try #require(fields.count == 2)
        let (one, two) = keptBelow ? (fields[1], fields[0]) : (fields[0], fields[1])

        one.becomeFirstResponder()
        await settle()
        for key in "keep" { one.insertText(String(key)) }
        await settle()
        // The caret moves on: the line's write fails and it stays in the field.
        two.becomeFirstResponder()
        await until { one.text == "keep" && !failsFirst }
        await settle()
        for key in "Foo" { two.insertText(String(key)) }
        two.setMarkedText("k", selectedRange: NSRange(location: 1, length: 0))
        await settle()

        notifications.post(name: UIApplication.didEnterBackgroundNotification, object: nil)
        await until { written.count == 2 }
        #expect(written.sorted() == ["Fook", "keep"], "\(written)")
    }

    /// A text view drawn over the first line, such as a sheet's note field,
    /// is not the line's: its composition stays, and the line lands only
    /// what the line kept.
    @Test(.timeLimit(.minutes(1))) func a_text_view_over_the_first_line_does_not_land_as_it() async throws {
        var written: [String] = []
        var failsFirst = true
        let scene = try #require(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let window = UIWindow(windowScene: scene)
        defer { window.isHidden = true }
        window.rootViewController = UIHostingController(rootView: JournalDayFirstLine(placeholder: "one") { line, _ in
            if failsFirst { failsFirst = false; return false }
            written.append(line)
            return true
        }
        .overlay(OverTextView())
        .environment(\.appLifecycle, notifications))
        window.makeKeyAndVisible()
        await until { views(UITextView.self, in: window).count == 2 }
        let over = try #require(views(UITextView.self, in: window).first { $0.tag == OverTextView.tag })
        let line = try #require(views(UITextView.self, in: window).first { $0.tag != OverTextView.tag })

        line.becomeFirstResponder()
        await settle()
        for key in "keep" { line.insertText(String(key)) }
        await settle()
        // The caret moves to the view over the line: the line's write fails
        // and it stays in the field.
        over.becomeFirstResponder()
        await until { line.text == "keep" && !failsFirst }
        await settle()
        for key in "Foo" { over.insertText(String(key)) }
        over.setMarkedText("k", selectedRange: NSRange(location: 1, length: 0))
        await settle()

        notifications.post(name: UIApplication.willResignActiveNotification, object: nil)
        notifications.post(name: UIApplication.didEnterBackgroundNotification, object: nil)
        await until { !written.isEmpty }
        await settle()
        #expect(written == ["keep"], "\(written)")
        #expect(over.markedTextRange != nil, "the line ended another view's composition")
    }
}

/// A plain text view drawn over the first line, as a sheet's field may be.
private struct OverTextView: UIViewRepresentable {
    static let tag = 4781

    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.tag = Self.tag
        return view
    }

    func updateUIView(_ view: UITextView, context: Context) {}
}
