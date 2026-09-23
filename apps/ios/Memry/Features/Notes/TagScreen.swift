//
//  TagScreen.swift
//  N600 — the screen a `#tag` leads to.
//
//  `NoteBlockView` marked tags but did not link them, and said why: there was
//  nowhere to go, and a word that looks tappable and does nothing is worse
//  than a word that does not. This is the somewhere.
//

import MemryCore
import Observation
import SwiftUI

/// A route to one tag's notes, so a tap can push onto the same stack a wiki
/// link pushes onto.
struct TagRoute: Hashable, Codable, Sendable {
    let name: String
}

@MainActor
@Observable
final class TagListViewModel {
    enum Phase: Equatable {
        case loading
        case ready([TagSummary])
        case failed(UserFacingError)
    }

    private let reader: any NotesReading
    private(set) var phase: Phase = .loading
    private var hasLoaded = false

    init(reader: any NotesReading) {
        self.reader = reader
    }

    func loadIfNeeded() async {
        guard !hasLoaded else { return }
        hasLoaded = true
        await load()
    }

    func reload() async { await load() }

    private func load() async {
        do {
            phase = .ready(try await reader.tags())
        } catch {
            Log.storage.error("the tag list could not be read")
            phase = .failed(ErrorMapping.userFacing(error))
        }
    }
}

/// One tag's notes.
@MainActor
@Observable
final class TaggedNotesViewModel {
    enum Phase: Equatable {
        case loading
        case ready([NoteSummary])
        case failed(UserFacingError)
    }

    let tag: String
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
        do {
            phase = .ready(try await reader.notesTagged(tag))
        } catch {
            Log.storage.error("a tag's notes could not be read")
            phase = .failed(ErrorMapping.userFacing(error))
        }
    }
}

/// Every tag in the vault.
struct TagListView: View {
    @State private var model: TagListViewModel
    let open: (TagRoute) -> Void

    init(reader: any NotesReading, open: @escaping (TagRoute) -> Void) {
        _model = State(initialValue: TagListViewModel(reader: reader))
        self.open = open
    }

    var body: some View {
        Group {
            switch model.phase {
            case .loading:
                ProgressView { Text("Reading your tags") }
                    .progressViewStyle(.circular)
                    .font(Tokens.Typography.supporting.font)
            case let .ready(tags):
                if tags.isEmpty {
                    // The truth about this vault, not a shrug.
                    Text("No note here carries a tag yet.")
                        .font(Tokens.Typography.supporting.font)
                        .foregroundStyle(Tokens.Text.secondary.color)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(Tokens.Space.screenInline)
                } else {
                    List(tags, id: \.name) { tag in
                        Button {
                            open(TagRoute(name: tag.name))
                        } label: {
                            HStack {
                                Text(tag.name)
                                    .font(Tokens.Typography.body.font)
                                    .foregroundStyle(Tokens.Text.primary.color)
                                Spacer()
                                Text("\(tag.noteCount)")
                                    .font(Tokens.Typography.caption.font)
                                    .foregroundStyle(Tokens.Text.secondary.color)
                            }
                        }
                        // One phrase rather than two elements, so VoiceOver
                        // reads "research, 12 notes" and not "research" then
                        // a bare number.
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel(
                            "\(tag.name), \(tag.noteCount) \(tag.noteCount == 1 ? "note" : "notes")"
                        )
                    }
                    .listStyle(.plain)
                }
            case let .failed(error):
                ErrorNotice(error: error, code: nil)
                Button("Try again") { Task { await model.reload() } }
                    .memrySecondaryAction()
            }
        }
        .navigationTitle("Tags")
        .background(Tokens.Canvas.background.color)
        .task { await model.loadIfNeeded() }
    }
}

/// The notes carrying one tag.
struct TaggedNotesView: View {
    @State private var model: TaggedNotesViewModel
    let open: (NoteRoute) -> Void

    init(tag: String, reader: any NotesReading, open: @escaping (NoteRoute) -> Void) {
        _model = State(initialValue: TaggedNotesViewModel(tag: tag, reader: reader))
        self.open = open
    }

    var body: some View {
        Group {
            switch model.phase {
            case .loading:
                ProgressView { Text("Reading these notes") }
                    .progressViewStyle(.circular)
                    .font(Tokens.Typography.supporting.font)
            case let .ready(notes):
                if notes.isEmpty {
                    // Reachable: a tag screen opened from a link in a note
                    // whose own tag row has since been removed elsewhere.
                    Text("No note carries this tag any more.")
                        .font(Tokens.Typography.supporting.font)
                        .foregroundStyle(Tokens.Text.secondary.color)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(Tokens.Space.screenInline)
                } else {
                    List(notes, id: \.id) { note in
                        Button {
                            open(NoteRoute(id: note.id))
                        } label: {
                            HStack(spacing: Tokens.Space.small) {
                                if let emoji = note.emoji {
                                    Text(emoji)
                                }
                                Text(note.title.isEmpty ? "Untitled" : note.title)
                                    .font(Tokens.Typography.body.font)
                                    .foregroundStyle(Tokens.Text.primary.color)
                            }
                        }
                    }
                    .listStyle(.plain)
                }
            case let .failed(error):
                ErrorNotice(error: error, code: nil)
            }
        }
        .navigationTitle("#\(model.tag)")
        .background(Tokens.Canvas.background.color)
        .task { await model.loadIfNeeded() }
    }
}
