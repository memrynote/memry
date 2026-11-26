import Foundation
import MemryCore

// The reads that follow a note's read, split from `NoteRead.swift`. Each
// answers `nil` when its task was cancelled, so the page keeps what it drew.

extension NoteReadViewModel {
    /// A task block the vault holds no task for draws from its own props.
    func readTaskCards() async -> [String: TaskCard]? {
        var cards: [String: TaskCard] = [:]
        for block in blocks where block.kind == "taskBlock" {
            guard let id = block.props.first(where: { $0.name == "taskId" })?.value, !id.isEmpty
            else { continue }
            if let card = try? await reader.task(id: id) { cards[id] = card }
        }
        return Task.isCancelled ? nil : cards
    }

    /// A failure answers an empty list: not seeing a comment is much smaller
    /// than not seeing the note.
    func readComments() async -> [ReviewComment]? {
        do {
            return try await reader.comments(id: route.id)
        } catch {
            if Task.isCancelled { return nil }
            let mapped = ErrorMapping.userFacing(error)
            Log.storage.error("this note's review comments could not be read", .code(mapped.code))
            return []
        }
    }

    /// The structure of every table in the body.
    ///
    /// A table that will not read is **left out rather than emptied**, and
    /// the view draws its placeholder: an empty `TableContent` would claim
    /// the note holds a table with no rows, which is a different note.
    func readTables() async -> [String: TableContent]? {
        var loaded: [String: TableContent] = [:]
        for block in blocks where block.kind == "table" {
            guard let blockId = block.id else { continue }
            do {
                if let table = try await reader.table(id: route.id, blockId: blockId) {
                    loaded[blockId] = table
                }
            } catch {
                if Task.isCancelled { return nil }
                let mapped = ErrorMapping.userFacing(error)
                Log.storage.error("a table in this note could not be read", .code(mapped.code))
            }
        }
        return loaded
    }

    /// The vault's notes, for the wiki-link search (N602).
    ///
    /// A failure answers an empty list rather than failing the screen: not
    /// being able to search for a link is much smaller than not being able to
    /// read the note.
    func readVaultNotes() async -> [NoteSummary]? {
        do {
            return try await reader.list()
        } catch {
            if Task.isCancelled { return nil }
            Log.storage.error("the vault's notes could not be listed for linking")
            return []
        }
    }

    /// Every tag's chosen colour by lowercased name, and every tag name, most
    /// used first. A failure answers `nil` too: the colours drawn stay.
    func readVaultTags() async -> (colors: [String: String], names: [String])? {
        do {
            var colors: [String: String] = [:]
            let tags = try await reader.tags()
            for tag in tags {
                if let color = tag.color, !color.isEmpty { colors[tag.name.lowercased()] = color }
            }
            return (colors, tags.sorted { $0.noteCount > $1.noteCount }.map(\.name))
        } catch {
            if Task.isCancelled { return nil }
            Log.storage.error("the vault's tag colours could not be read")
            return nil
        }
    }
}
