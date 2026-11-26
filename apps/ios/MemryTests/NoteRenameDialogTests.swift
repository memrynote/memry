import MemryCore
import SwiftUI
import Testing
import UIKit
@testable import Memry

/// The core's notes writer, recording the titles the page menu writes.
private final class RecordedTitles: NotesWriting, @unchecked Sendable {
    private let core: CoreNotesWriter
    private let lock = NSLock()
    private var written: [String] = []
    private var copied: [String] = []
    /// Every title the page menu's Rename wrote.
    var titles: [String] { lock.withLock { written } }
    /// Every title the page menu's Duplicate gave a copy.
    var copies: [String] { lock.withLock { copied } }

    init(_ core: CoreNotesWriter) { self.core = core }

    func rename(id: String, title: String) async throws {
        lock.withLock { written.append(title) }
        try await core.rename(id: id, title: title)
    }

    func create(title: String, folderPath: String?) async throws -> String {
        try await core.create(title: title, folderPath: folderPath)
    }
    func move(id: String, folderPath: String?) async throws { try await core.move(id: id, folderPath: folderPath) }
    func delete(id: String) async throws { try await core.delete(id: id) }
    func createFromTemplate(templateId: String, title: String, folderPath: String?) async throws -> String {
        try await core.createFromTemplate(templateId: templateId, title: title, folderPath: folderPath)
    }
    func addReminder(noteId: String, remindAt: String, title: String?) async throws -> String {
        try await core.addReminder(noteId: noteId, remindAt: remindAt, title: title)
    }
    func dismissReminder(id: String) async throws { try await core.dismissReminder(id: id) }
    func snoozeReminder(id: String, until: String) async throws { try await core.snoozeReminder(id: id, until: until) }
    func createFolder(path: String) async throws { try await core.createFolder(path: path) }
    func setFolderIcon(path: String, icon: String?) async throws {
        try await core.setFolderIcon(path: path, icon: icon)
    }
    func renameFolder(path: String, newName: String) async throws {
        try await core.renameFolder(path: path, newName: newName)
    }
    func moveFolder(path: String, newParent: String?) async throws {
        try await core.moveFolder(path: path, newParent: newParent)
    }
    func deleteFolder(path: String) async throws { try await core.deleteFolder(path: path) }
    func duplicate(id: String, title: String) async throws -> String? {
        lock.withLock { copied.append(title) }
        return try await core.duplicate(id: id, title: title)
    }
}

extension KeyWindowSuites.NoteTitleRehostTests {
    /// #4691: the page menu's Rename over a title typed and not yet committed.
    /// Nested so it runs one test at a time with the re-host tests: both put a
    /// page in a scene window and give its title the caret.
    @Suite("Note rename dialog over a pending title")
    @MainActor
    struct NoteRenameDialogTests {
        private struct Fixture {
            let vault: TasksTestVault
            let noteId: String
            let reader: CoreNotesReader
            let writer: RecordedTitles
        }

        private func fixture(title: String) throws -> Fixture {
            let vault = try TasksTestVault()
            let notes = CoreNotesWriter(vault: vault.vault, store: TaskTestKeychain(), executor: .shared)
            let noteId = try vault.vault.notesWriter(store: TaskTestKeychain()).create(title: title, folderPath: nil)
            return Fixture(
                vault: vault, noteId: noteId,
                reader: CoreNotesReader(vault: vault.vault, executor: .shared),
                writer: RecordedTitles(notes)
            )
        }

        /// The note page in a navigation stack, so its toolbar and page menu draw.
        private func host(_ f: Fixture, in window: UIWindow) {
            let page = NavigationStack {
                NoteReadView(
                    route: NoteRoute(id: f.noteId), reader: f.reader,
                    metadataWriter: CoreNoteMetadataWriter(
                        vault: f.vault.vault, store: TaskTestKeychain(), executor: .shared
                    ),
                    writer: f.writer
                )
            }
            window.rootViewController = UIHostingController(rootView: page)
            window.makeKeyAndVisible()
        }

        private func sceneWindow() throws -> UIWindow {
            let scene = try #require(UIApplication.shared.connectedScenes.first as? UIWindowScene)
            return UIWindow(windowScene: scene)
        }

        private func views(in view: UIView) -> [UIView] {
            [view] + view.subviews.flatMap(views)
        }

        /// The page's title field: the one text view that is not a block.
        private func titleField(in window: UIWindow) -> UITextView? {
            window.rootViewController?.view.flatMap { root in
                views(in: root).lazy.compactMap { $0 as? UITextView }.first { !($0 is BlockTextView) }
            }
        }

        /// The page menu's item called `title` among `elements`. SwiftUI hands
        /// a menu its items as one deferred element, filled when the menu shows.
        private func leaf(_ title: String, in elements: [UIMenuElement]) -> UIAction? {
            for element in elements {
                if let action = element as? UIAction, action.title == title { return action }
                if let menu = element as? UIMenu, let found = leaf(title, in: menu.children) { return found }
                if let deferred = element as? UIDeferredMenuElement,
                   let filled = deferred.perform(NSSelectorFromString("fulfilledElements"))?
                       .takeUnretainedValue() as? [UIMenuElement],
                   let found = leaf(title, in: filled) { return found }
            }
            return nil
        }

        /// Opens the page menu and picks `title`, as a tap on each would.
        private func pickPageMenuItem(_ title: String, in window: UIWindow) async throws {
            // The bar's one menu button. Its label is not read here: a
            // bar button has one only once accessibility is on.
            func button() -> UIView? {
                views(in: window).compactMap { $0 as? UINavigationBar }.flatMap { views(in: $0) }
                    .first { $0 is UIControl && $0.interactions.contains { $0 is UIContextMenuInteraction } }
            }
            await until { button() != nil }
            let more = try #require(button(), "the page menu was not drawn")
            let interaction = try #require(more.interactions.lazy.compactMap { $0 as? UIContextMenuInteraction }.first)
            // Private: the menu has no public way to open but a touch.
            let present = NSSelectorFromString("_presentMenuAtLocation:")
            typealias Present = @convention(c) (AnyObject, Selector, CGPoint) -> Void
            unsafeBitCast(interaction.method(for: present), to: Present.self)(
                interaction, present, CGPoint(x: more.bounds.midX, y: more.bounds.midY)
            )
            let bars = views(in: window).compactMap { $0 as? UINavigationBar }
            let menus = bars.flatMap { $0.items ?? [] }
                .flatMap { $0.trailingItemGroups.flatMap(\.barButtonItems) }
                .compactMap(\.menu)
            await until { leaf(title, in: menus) != nil }
            let action = try #require(leaf(title, in: menus), "the page menu has no \(title)")
            interaction.dismissMenu()
            try await Task.sleep(for: .milliseconds(500))
            action.performWithSender(nil, target: nil)
        }

        private func presentedAlert(in window: UIWindow) -> UIAlertController? {
            var controller = window.rootViewController?.presentedViewController
            while let next = controller?.presentedViewController { controller = next }
            return controller as? UIAlertController
        }

        /// Runs the alert button called `title` as a tap on it would.
        private func tap(_ title: String, in alert: UIAlertController) throws {
            typealias Handler = @convention(block) (UIAlertAction) -> Void
            let action = try #require(alert.actions.first { $0.title == title }, "no \(title) button")
            let handler = try #require(action.value(forKey: "handler") as AnyObject?, "the button has no handler")
            unsafeBitCast(handler, to: Handler.self)(action)
            alert.dismiss(animated: false)
        }

        private func until(_ condition: () -> Bool) async {
            for _ in 0..<300 where !condition() {
                try? await Task.sleep(for: .milliseconds(20))
            }
        }

        private func savedTitle(_ f: Fixture) async throws -> String? {
            try await f.reader.read(id: f.noteId)?.summary.title
        }

        /// Opens the page on a note titled "Heron" and types " Kestrel" into its
        /// title without committing it.
        private func typeTitle(_ f: Fixture, in window: UIWindow) async throws {
            host(f, in: window)
            await until { titleField(in: window) != nil }
            let field = try #require(titleField(in: window), "the title field was not drawn")
            field.becomeFirstResponder()
            await until { field.isFirstResponder }
            try await Task.sleep(for: .milliseconds(200))
            field.selectedRange = NSRange(location: 5, length: 0)
            field.insertText(" Kestrel")
            await until { field.text == "Heron Kestrel" }
            // The page hears of the edit a turn after the field.
            try await Task.sleep(for: .milliseconds(200))
        }

        /// Type a title, open Rename before the title is committed, and confirm
        /// the dialog unchanged. The dialog shows the typed title, and the typed
        /// title is what stays stored.
        @Test(.timeLimit(.minutes(1))) func renaming_unchanged_keeps_the_typed_title() async throws {
            let f = try fixture(title: "Heron")
            let window = try sceneWindow()
            defer { window.isHidden = true }
            try await typeTitle(f, in: window)

            try await pickPageMenuItem("Rename", in: window)
            await until { presentedAlert(in: window) != nil }
            let alert = try #require(presentedAlert(in: window), "the Rename dialog did not present")
            #expect(alert.textFields?.first?.text == "Heron Kestrel", "the dialog does not show the typed title")
            // The dialog took the caret, which ends the title edit and saves it.
            for _ in 0..<300 where (try? await savedTitle(f)) != "Heron Kestrel" {
                try await Task.sleep(for: .milliseconds(20))
            }
            try tap("Rename", in: alert)
            try await Task.sleep(for: .milliseconds(500))

            #expect(try await savedTitle(f) == "Heron Kestrel", "Rename wrote: \(f.writer.titles)")
            #expect(f.writer.titles.isEmpty, "an unchanged Rename wrote: \(f.writer.titles)")
        }

        /// Duplicate names the copy after the title typed, not the stored one.
        @Test(.timeLimit(.minutes(1))) func duplicate_names_the_copy_after_the_typed_title() async throws {
            let f = try fixture(title: "Heron")
            let window = try sceneWindow()
            defer { window.isHidden = true }
            try await typeTitle(f, in: window)

            try await pickPageMenuItem("Duplicate", in: window)
            await until { !f.writer.copies.isEmpty }

            #expect(f.writer.copies == ["Heron Kestrel copy"])
        }
    }
}
