import CoreTransferable
import Foundation
import MemryCore
import Synchronization
import Testing
import UIKit
import UniformTypeIdentifiers

@testable import Memry

// #4357: the drop handlers over the providers a drag session hands them. The
// Inbox drop captures through the composer's path into a real scratch vault,
// a task drop dates the task through the calendar's task write, and a note
// drag carries its text and its `memry://note/<id>` link. Serialized: the
// note drag state is one per app.

@MainActor
@Suite("Drag and drop", .serialized)
struct DragDropTests {
    // MARK: Inbox

    private static let onePixelPNG = Data(base64Encoded:
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
    ) ?? Data()

    private static func file(_ data: Data, ext: String) throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("[agent] drop-\(UUID().uuidString).\(ext)")
        try data.write(to: url)
        return url
    }

    private static func fileProvider(_ url: URL, type: UTType, name: String) -> NSItemProvider {
        let provider = NSItemProvider()
        provider.registerFileRepresentation(for: type, visibility: .all) { completion in
            completion(url, false, nil)
            return nil
        }
        provider.suggestedName = name
        return provider
    }

    @Test func dropped_text_and_an_image_are_captured_as_the_composer_captures_them() async throws {
        let vault = try InboxTestVault()
        let image = try Self.file(Self.onePixelPNG, ext: "png")
        let providers = [
            NSItemProvider(object: "[agent] dropped text" as NSString),
            Self.fileProvider(image, type: .png, name: "[agent] dropped")
        ]
        let captured = await vault.store.captureDropped(providers)
        #expect(captured == 2)
        #expect(vault.store.failure == nil)
        let types = Set(vault.store.items.map(\.itemType))
        #expect(types == ["note", "image"], "\(vault.store.items.map(\.itemType))")
        #expect(vault.store.items.contains { $0.content?.contains("[agent] dropped text") == true || $0.title.contains("[agent] dropped text") })
    }

    @Test func a_dropped_web_address_is_a_link_and_a_task_drag_is_not_text() async {
        let link = NSItemProvider(object: URL(string: "https://example.com/a")! as NSURL)
        let task = NSItemProvider(object: TaskDragPayload.encode(["t1"]) as NSString)
        let zip = NSItemProvider()
        zip.registerDataRepresentation(for: .zip, visibility: .all) { completion in
            completion(Data([0x50, 0x4B]), nil)
            return nil
        }
        let items = await InboxDrop.read([link, task, zip]) { _, _ in nil }
        #expect(items == [.link("https://example.com/a")])
    }

    /// A task drag carries text too, and the Inbox does not take it, so it
    /// is not outlined; a day still reads the task ids out of it.
    @Test func a_task_drag_is_not_taken_by_the_inbox_and_still_dates_a_day() async {
        let task = NSItemProvider()
        task.register(TaskDrag(ids: ["t1"]))
        let link = NSItemProvider(object: URL(string: "https://example.com/a")! as NSURL)
        func conforms(_ provider: NSItemProvider) -> ([UTType]) -> Bool {
            { types in types.contains { provider.hasItemConformingToTypeIdentifier($0.identifier) } }
        }
        #expect(!InboxDrop.takes(conforms(task)))
        #expect(InboxDrop.takes(conforms(link)))
        let text: String? = await withCheckedContinuation { continuation in
            _ = task.loadTransferable(type: String.self) { continuation.resume(returning: try? $0.get()) }
        }
        #expect(text == TaskDragPayload.encode(["t1"]))
    }

    @Test func a_dropped_file_that_will_not_copy_or_open_is_shown_and_several_are_counted() async throws {
        let vault = try InboxTestVault()
        let unreadable = NSItemProvider()
        unreadable.registerFileRepresentation(for: .pdf, visibility: .all) { completion in
            completion(nil, false, CocoaError(.fileReadNoSuchFile))
            return nil
        }
        #expect(await vault.store.captureDropped([unreadable]) == 0)
        #expect(vault.store.failure?.code == InboxErrors.dropUnreadable.code)

        let gone = FileManager.default.temporaryDirectory
            .appendingPathComponent("[agent] gone-\(UUID().uuidString).pdf")
        let unopenable = InboxDrop.Item.file(gone, filename: "gone.pdf", mimeType: "application/pdf")
        #expect(await vault.store.capture(dropped: [unopenable]) == 0)
        #expect(vault.store.failure?.code == InboxErrors.dropUnopenable.code)

        let captured = await vault.store.capture(dropped: [
            .text("[agent] kept"),
            .failed(InboxErrors.dropUnreadable),
            unopenable
        ])
        #expect(captured == 1)
        #expect(vault.store.failure == InboxErrors.dropFailed(2, first: InboxErrors.dropUnreadable))
        #expect(vault.store.failure?.title.hasPrefix("2 ") == true)
    }

    /// A capture's write clears the failure row, so a failed item followed by
    /// a captured one must still leave the failure on screen.
    @Test func a_failure_stays_visible_after_a_later_item_of_the_drop_is_captured() async throws {
        let vault = try InboxTestVault()
        let captured = await vault.store.capture(dropped: [
            .failed(InboxErrors.dropUnreadable),
            .text("[agent] kept after a failure")
        ])
        #expect(captured == 1)
        #expect(vault.store.failure == InboxErrors.dropUnreadable)
    }

    /// The picked-file limit holds for a drop: a file over 50 MB is refused
    /// with the visible "too large" failure, and nothing is captured.
    @Test func a_dropped_file_over_the_limit_is_refused_on_screen() async throws {
        let vault = try InboxTestVault()
        let big = try Self.file(Data(count: 50 * 1024 * 1024 + 1), ext: "pdf")
        defer { try? FileManager.default.removeItem(at: big) }
        let captured = await vault.store.captureDropped([Self.fileProvider(big, type: .pdf, name: "[agent] big.pdf")])
        #expect(captured == 0)
        #expect(vault.store.failure?.code == InboxErrors.tooLarge.code)
        #expect(vault.store.items.isEmpty)

        // Refused on the provider's size, before this app copies it.
        let size = Mutex<UInt64?>(nil)
        let items = await InboxDrop.read([Self.fileProvider(big, type: .pdf, name: "[agent] big.pdf")]) { _, checked in
            size.withLock { $0 = checked }
            return InboxErrors.fileRefusal(size: checked)
        }
        let expected: [InboxDrop.Item] = [.failed(InboxErrors.tooLarge)]
        #expect(items == expected)
        let checked: UInt64? = size.withLock { $0 }
        let overLimit: UInt64 = 50 * 1024 * 1024 + 1
        #expect(checked == overLimit)
    }

    // MARK: Notes

    @Test func a_note_is_not_moved_onto_the_folder_it_is_in() {
        #expect(!NoteFolderDrop.moves(from: "Work", to: "Work"))
        #expect(!NoteFolderDrop.moves(from: nil, to: nil))
        #expect(!NoteFolderDrop.moves(from: "", to: nil))
        #expect(NoteFolderDrop.moves(from: "Work", to: "Work/Interviews"))
        #expect(NoteFolderDrop.moves(from: "Work", to: nil))
        #expect(NoteFolderDrop.moves(from: nil, to: "Work"))
    }

    private static func note(_ id: String, in folder: String?) -> NoteSummary {
        NoteSummary(
            id: id, title: "[agent] \(id)", folderPath: folder, emoji: nil, createdAt: nil, modifiedAt: nil, aliases: []
        )
    }

    @Test func a_dragged_note_carries_its_payload_text_and_memry_link() async throws {
        let note = Self.note("n1", in: "Work")
        let provider = NoteDrag.provider(for: note, vaultId: "vault-a") { "[agent] Plan\n\nBody" }
        defer { NoteDrag.dropped() }
        #expect(await NoteFolderDrop.payloads(from: [provider]) == [NoteDragPayload(noteId: "n1", vaultId: "vault-a")])
        let text: String? = await withCheckedContinuation { continuation in
            _ = provider.loadDataRepresentation(for: .utf8PlainText) { data, _ in
                continuation.resume(returning: data.map { String(decoding: $0, as: UTF8.self) })
            }
        }
        #expect(text == "[agent] Plan\n\nBody")
        let link: URL? = await withCheckedContinuation { continuation in
            _ = provider.loadObject(ofClass: NSURL.self) { object, _ in
                continuation.resume(returning: (object as? NSURL) as URL?)
            }
        }
        #expect(link?.absoluteString == NoteRelationValue.uri(noteId: "n1"))
    }

    /// A folder takes only Memry's note type: a Safari link carries none,
    /// and a note of another vault moves nothing, so the drop is refused.
    @Test func a_folder_refuses_a_safari_link_and_another_vaults_note() async {
        NoteDrag.dropped()
        let outline = VaultOutline.build(
            folders: [FolderSummary(path: "Work", parentPath: nil, name: "Work", icon: nil)],
            notes: [Self.note("n1", in: "Work")]
        )
        let safari = NSItemProvider(object: URL(string: "https://example.com/note/n1")! as NSURL)
        #expect(!NoteFolderDrop.types.contains { safari.hasItemConformingToTypeIdentifier($0.identifier) })
        #expect(await NoteFolderDrop.payloads(from: [safari]).isEmpty)
        #expect(NoteFolderDrop.moving(NoteDrag.dragged, vaultId: "vault-a", outline: outline, to: nil).isEmpty)

        let other = NoteDrag.provider(for: Self.note("n1", in: "Work"), vaultId: "vault-b") { nil }
        #expect(NoteFolderDrop.moving(NoteDrag.dragged, vaultId: "vault-a", outline: outline, to: nil).isEmpty)
        let loaded = await NoteFolderDrop.payloads(from: [other])
        #expect(NoteFolderDrop.moving(loaded, vaultId: "vault-a", outline: outline, to: nil).isEmpty)
        #expect(NoteFolderDrop.moving(loaded, vaultId: "vault-b", outline: outline, to: nil).map(\.id) == ["n1"])

        NoteDrag.dropped()
        #expect(NoteDrag.dragged.isEmpty)
    }

    /// The hover state lives only while the system holds the drag.
    @Test func a_released_drag_leaves_no_hover_state() {
        NoteDrag.dropped()
        autoreleasepool {
            _ = NoteDrag.provider(for: Self.note("n1", in: "Work"), vaultId: "vault-a") { nil }
        }
        #expect(NoteDrag.dragged.isEmpty)
    }

    /// Every note of a multi-item drag moves, through the menu's move, and
    /// the hover check counts each; one already in the folder stays.
    @Test func every_note_of_a_multi_note_drag_moves() async throws {
        NoteDrag.dropped()
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("memry-drop-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let vault = try Vault.open(vaultId: "vault-drop", directory: directory.path)
        let model = VaultBrowseViewModel(vault: vault, executor: CoreExecutor(), store: TaskTestKeychain())
        let writer = try #require(model.writer)
        try await writer.createFolder(path: "Work")
        try await writer.createFolder(path: "Target")
        let work = try await writer.create(title: "[agent] A", folderPath: "Work")
        let root = try await writer.create(title: "[agent] B", folderPath: nil)
        let there = try await writer.create(title: "[agent] C", folderPath: "Target")
        await model.reload()
        let notes = try #require(model.outline?.allNotes)
        let providers = try [work, root, there].map { id in
            NoteDrag.provider(for: try #require(notes.first { $0.id == id }), vaultId: "vault-drop") { nil }
        }
        defer { NoteDrag.dropped() }
        let hovering = NoteFolderDrop.moving(
            NoteDrag.dragged, vaultId: "vault-drop", outline: model.outline, to: "Target"
        )
        #expect(Set(hovering.map(\.id)) == [work, root])

        #expect(await NoteFolderDrop.drop(providers, vaultId: "vault-drop", on: "Target", model: model) == 2)
        await model.reload()
        let inTarget = model.outline?.allNotes.filter { $0.folderPath == "Target" }.map(\.id) ?? []
        #expect(Set(inTarget) == [work, root, there])
        #expect(model.writeFailure == nil)
    }

    // MARK: Tasks

    @Test func a_task_dropped_on_a_day_takes_that_date_and_keeps_its_time() async throws {
        let tasks = try TasksTestVault()
        let project = try tasks.project()
        let id = try tasks.task("[agent] dated", project: project, due: "2026-01-14")
        _ = try tasks.tasks.setDue(id: id, date: "2026-01-14", time: "09:30")
        await tasks.store.load()
        let calendar = CalendarStore(
            core: try tasks.vault.calendar(store: TaskTestKeychain()), vaultId: "vault-test", filler: nil, tasks: tasks.store
        )

        let ids = calendar.droppedTaskIds([TaskDragPayload.encode([id]), id, "[agent] a note's text"])
        #expect(ids == [id])
        await calendar.dateTasks(ids, to: "2026-01-20")

        let task = try #require(try tasks.tasks.get(id: id))
        #expect(task.dueDate == "2026-01-20")
        #expect(task.dueTime == "09:30")
        #expect(calendar.toast?.message == CalendarCopy.taskRescheduled)
        await calendar.toast?.undo?()
        #expect(try tasks.tasks.get(id: id)?.dueDate == "2026-01-14")
    }

    /// Several tasks dropped at once: one write, one toast, one Undo that
    /// puts every one back. A task already due that day is left alone.
    @Test func several_tasks_dropped_on_a_day_get_one_toast_and_one_undo() async throws {
        let tasks = try TasksTestVault()
        let project = try tasks.project()
        let timed = try tasks.task("[agent] timed", project: project, due: "2026-01-14")
        _ = try tasks.tasks.setDue(id: timed, date: "2026-01-14", time: "09:30")
        let untimed = try tasks.task("[agent] untimed", project: project, due: "2026-01-15")
        let there = try tasks.task("[agent] there", project: project, due: "2026-01-20")
        await tasks.store.load()
        let calendar = CalendarStore(
            core: try tasks.vault.calendar(store: TaskTestKeychain()),
            vaultId: "vault-test", filler: nil, tasks: tasks.store
        )

        await calendar.dateTasks([timed, untimed, there], to: "2026-01-20")
        #expect(try tasks.tasks.get(id: timed)?.dueDate == "2026-01-20")
        #expect(try tasks.tasks.get(id: timed)?.dueTime == "09:30")
        #expect(try tasks.tasks.get(id: untimed)?.dueDate == "2026-01-20")
        #expect(calendar.toast?.message == CalendarCopy.tasksRescheduled(2))

        await calendar.toast?.undo?()
        #expect(try tasks.tasks.get(id: timed)?.dueDate == "2026-01-14")
        #expect(try tasks.tasks.get(id: timed)?.dueTime == "09:30")
        #expect(try tasks.tasks.get(id: untimed)?.dueDate == "2026-01-15")
        #expect(try tasks.tasks.get(id: there)?.dueDate == "2026-01-20")
    }
}
