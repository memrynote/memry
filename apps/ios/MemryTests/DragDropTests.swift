import Foundation
import MemryCore
import Testing
import UIKit
import UniformTypeIdentifiers

@testable import Memry

// #4357: the drop handlers over the providers a drag session hands them. The
// Inbox drop captures through the composer's path into a real scratch vault,
// a task drop dates the task through the calendar's task write, and a note
// drag carries its text and its `memry://note/<id>` link.

@MainActor
@Suite("Drag and drop")
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
        let items = await InboxDrop.read([link, task, zip])
        #expect(items == [.link("https://example.com/a")])
    }

    /// The picked-file limit holds for a drop: a file over 50 MB is refused
    /// with the visible "too large" failure, and nothing is captured.
    @Test func a_dropped_file_over_the_limit_is_refused_on_screen() async throws {
        let vault = try InboxTestVault()
        let big = try Self.file(Data(count: 50 * 1024 * 1024 + 1), ext: "pdf")
        let captured = await vault.store.captureDropped([Self.fileProvider(big, type: .pdf, name: "[agent] big.pdf")])
        #expect(captured == 0)
        #expect(vault.store.failure?.code == InboxErrors.tooLarge.code)
        #expect(vault.store.items.isEmpty)
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

    @Test func a_dragged_note_carries_its_text_and_its_memry_link() async throws {
        let note = NoteSummary(
            id: "n1", title: "[agent] Plan", folderPath: "Work", emoji: nil, createdAt: nil, modifiedAt: nil, aliases: []
        )
        let provider = NoteDrag.provider(for: note) { "[agent] Plan\n\nBody" }
        let outline = VaultOutline.build(
            folders: [FolderSummary(path: "Work", parentPath: nil, name: "Work", icon: nil)],
            notes: [note]
        )
        let dropped = await NoteFolderDrop.note(from: provider, in: outline)
        #expect(dropped?.id == "n1")
        let text: String? = await withCheckedContinuation { continuation in
            _ = provider.loadDataRepresentation(for: .utf8PlainText) { data, _ in
                continuation.resume(returning: data.map { String(decoding: $0, as: UTF8.self) })
            }
        }
        #expect(text == "[agent] Plan\n\nBody")
        #expect(NoteFolderDrop.noteId(in: URL(string: "memry://calendar?date=2026-01-01")!) == nil)
        #expect(NoteFolderDrop.noteId(in: URL(string: "https://example.com/note/n1")!) == nil)
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
}
