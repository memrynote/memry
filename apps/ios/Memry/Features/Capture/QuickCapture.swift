import Foundation
import MemryCore
import Observation
import SwiftUI

// Quick capture: one line of text filed as an inbox item, a task, a note or a
// paragraph on today's journal day. Home's "+" offers all four; a page's own
// "+" can offer just its kind through the same sheet.
//
// **Each kind writes through the path its page already uses**, so a capture
// is indistinguishable from one made on that page: the inbox store's capture
// (duplicate check, link detection), tasks' quick add (the text is parsed, so
// "tomorrow" or "!2" means what it means in the Tasks composer), the notes
// writer, and the journal's `editDay`, which creates the day when it has no
// entry yet.

enum CaptureKind: String, CaseIterable, Identifiable, Sendable {
    case inbox, task, note, journal
    var id: String { rawValue }

    var title: String {
        switch self {
        case .inbox: InboxCopy.title
        case .task: "Task"
        case .note: "Note"
        case .journal: "Journal"
        }
    }

    /// The page a capture of this kind lands on.
    var page: VaultTab {
        switch self {
        case .inbox: .inbox
        case .task: .tasks
        case .note: .notes
        case .journal: .journal
        }
    }

    @MainActor var isShown: Bool {
        switch self {
        case .inbox: LocalSettings.shared.isOn(.inbox)
        case .task: LocalSettings.shared.isOn(.tasks)
        case .note: true
        case .journal: LocalSettings.shared.isOn(.journal)
        }
    }
}

/// What a capture left behind, for the confirmation and its "View".
struct CaptureReceipt: Equatable, Sendable {
    let kind: CaptureKind
    /// The new item's id; for a journal capture, the day's date.
    let id: String
    let message: String
}

extension EnvironmentValues {
    /// The opened vault's capture writers, set by the settings scope.
    @Entry var quickCapture: QuickCapture?
}

@MainActor
@Observable
final class QuickCapture {
    /// Bumped by every journal capture, so an open Journal page re-reads the
    /// day it did not write itself.
    private(set) var journalWrites = 0
    private let vault: Vault
    private let secureStore: any SecureStore
    private let tasks: TasksStore?
    private let inbox: InboxStore?
    private let writer: (any NotesWriting)?
    private let editor: (any BlockEditing)?
    private let executor: CoreExecutor

    init(
        vault: Vault,
        secureStore: any SecureStore,
        tasks: TasksStore?,
        inbox: InboxStore?,
        browse: VaultBrowseViewModel?,
        executor: CoreExecutor = .shared
    ) {
        self.vault = vault
        self.secureStore = secureStore
        self.tasks = tasks
        self.inbox = inbox
        writer = browse?.writer
        editor = browse?.editor
        self.executor = executor
    }

    /// The day a journal capture lands on.
    var today: String { JournalClock.debugPin() ?? JournalDates.key(Date()) }

    /// Files `text`; `nil` when it did not land (the caller keeps the text).
    func capture(_ text: String, as kind: CaptureKind) async -> CaptureReceipt? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let receipt: CaptureReceipt? = switch kind {
        case .inbox: await captureInbox(trimmed)
        case .task: await captureTask(trimmed)
        case .note: await captureNote(trimmed)
        case .journal: await captureJournal(trimmed)
        }
        if receipt != nil { tasks?.scheduleSync() }
        return receipt
    }

    private func captureInbox(_ text: String) async -> CaptureReceipt? {
        switch await inbox?.capture(text, source: "home") {
        case let .captured(id): CaptureReceipt(kind: .inbox, id: id, message: QuickCaptureCopy.added(to: .inbox))
        case let .duplicate(item): CaptureReceipt(kind: .inbox, id: item.id, message: QuickCaptureCopy.alreadyInInbox)
        case .failed, .none: nil
        }
    }

    private func captureTask(_ text: String) async -> CaptureReceipt? {
        guard let id = await tasks?.submitQuickAdd(text, preferredProjectId: nil, picks: QuickAddPicks()) else { return nil }
        return CaptureReceipt(kind: .task, id: id, message: QuickCaptureCopy.added(to: .task))
    }

    /// The first line is the title; every further line a paragraph.
    private func captureNote(_ text: String) async -> CaptureReceipt? {
        guard let writer else { return nil }
        var lines = text.components(separatedBy: .newlines)
        let title = lines.removeFirst().trimmingCharacters(in: .whitespaces)
        do {
            let id = try await writer.create(title: title, folderPath: LocalSettings.shared.newNotesFolder)
            for line in lines where !line.trimmingCharacters(in: .whitespaces).isEmpty {
                _ = try await editor?.edit(noteId: id, Self.paragraph(line))
            }
            return CaptureReceipt(kind: .note, id: id, message: QuickCaptureCopy.added(to: .note))
        } catch {
            let mapped = ErrorMapping.userFacing(error)
            Log.storage.error("a quick capture note did not land", .code(mapped.code))
            return nil
        }
    }

    /// Each line is a paragraph at the end of today's body.
    private func captureJournal(_ text: String) async -> CaptureReceipt? {
        let date = today
        let edits = text.components(separatedBy: .newlines)
            .filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
            .map(Self.paragraph)
        let vault = vault
        let secureStore = secureStore
        do {
            try await executor.run {
                let journal = try vault.journal(store: secureStore)
                for edit in edits { _ = try journal.editDay(date: date, edit: edit) }
            }
            journalWrites += 1
            return CaptureReceipt(kind: .journal, id: date, message: QuickCaptureCopy.added(to: .journal))
        } catch {
            let mapped = ErrorMapping.userFacing(error)
            Log.storage.error("a quick capture journal line did not land", .code(mapped.code))
            return nil
        }
    }

    /// A paragraph at the end of the body (`afterBlockId: nil`).
    private static func paragraph(_ text: String) -> BlockEdit {
        .insertParagraph(afterBlockId: nil, text: text, newBlockId: UUID().uuidString.lowercased())
    }
}

enum QuickCaptureCopy {
    static let placeholder = "What's on your mind?"
    static let journalPlaceholder = "Add to today"
    static let send = "Save"
    static let failed = "This did not save. Your text is still here."
    static let alreadyInInbox = "Already in Inbox"
    static let view = "View"
    static let add = "New"
    static let addHint = "Writes something down and files it"
    static let addToJournal = "Add to today"
    static let addToJournalHint = "Adds a line to today's journal entry"

    static func added(to kind: CaptureKind) -> String {
        switch kind {
        case .inbox: "Added to Inbox"
        case .task: "Added to Tasks"
        case .note: "Added to Notes"
        case .journal: "Added to today's journal"
        }
    }
}
