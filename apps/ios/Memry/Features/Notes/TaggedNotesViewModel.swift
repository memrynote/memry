import MemryCore
import Observation
import SwiftUI

/// A route to one tag's notes, so a tap can push onto the same stack a wiki
/// link pushes onto.
struct TagRoute: Hashable, Codable, Sendable {
    let name: String
}

/// A route to every tag, from the Notes root's Tags section.
struct TagListRoute: Hashable, Codable, Sendable {}

/// One tag's notes.
@MainActor
@Observable
final class TaggedNotesViewModel {
    enum Phase: Equatable {
        case loading
        case ready([NoteSummary])
        case failed(UserFacingError)
    }

    /// Changes when the tag is renamed or merged away from this page.
    var tag: String
    private let reader: any NotesReading
    private(set) var phase: Phase = .loading
    private var hasLoaded = false

    init(tag: String, reader: any NotesReading) {
        self.tag = tag
        self.reader = reader
    }

    func loadIfNeeded() async {
        guard !hasLoaded else { return }
        hasLoaded = true
        await load()
    }

    /// Re-reads when the screen comes back or the tag changed, so a note
    /// tagged or untagged in the meantime shows. Quiet: a failed read keeps
    /// what was there.
    func refresh() async {
        guard case .ready = phase, let notes = try? await reader.notesTagged(tag) else { return }
        phase = .ready(notes)
    }

    private func load() async {
        do {
            phase = .ready(try await reader.notesTagged(tag))
        } catch {
            Log.storage.error("a tag's notes could not be read")
            phase = .failed(ErrorMapping.userFacing(error))
        }
    }
}
