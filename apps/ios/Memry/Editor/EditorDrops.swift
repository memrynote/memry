//
//  EditorDrops.swift
//  #4357. Drops into a note's body on iPad. A note dragged from a Memry row
//  becomes a wiki link at the caret under the drop, through the `[[` menu's
//  insert. Files, pictures and PDFs from another app go through the
//  attachment pickers' upload, each into a block after the block under the
//  drop, text documents too (#4833). Text and links keep the text view's
//  own drop. A note dropped on the page off its lines links at the caret,
//  so a drop does not hang on the line staying under the finger: UIKit's
//  drag auto-scroll can move the page from under it.
//

import MemryCore
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// What a drop on a block does, read from its items' types, which are known
/// while the drag still hovers.
enum EditorDrop: Equatable {
    /// Notes dragged from this app: a wiki link to each.
    case notes
    /// Files: an attachment block for each.
    case files

    /// The media the paperclip offers, ahead of any other file.
    static let mediaTypes: [UTType] = [.image, .movie, .audio, .pdf]

    static func of(_ providers: [NSItemProvider]) -> EditorDrop? {
        if providers.contains(where: { $0.hasItemConformingToTypeIdentifier(UTType.memryNote.identifier) }) {
            return .notes
        }
        return providers.contains { fileType(of: $0) != nil } ? .files : nil
    }

    /// The type a provider's file is read as: a picture, movie, recording or
    /// PDF first (an image dragged from Safari also carries its address),
    /// else any other file, text documents included, as Choose File takes
    /// any. Nothing for text, a link or a Memry drag, which are not files to
    /// attach.
    static func fileType(of provider: NSItemProvider) -> UTType? {
        let types = provider.registeredContentTypes
        if let media = types.first(where: { type in mediaTypes.contains { type.conforms(to: $0) } }) {
            return media
        }
        // Text attaches only when the drag carries its file (a file URL or opened in place), whatever its type (#4833).
        let carriesFile = types.contains { $0.conforms(to: .fileURL) }
            || !provider.registeredTypeIdentifiers(fileOptions: [.openInPlace]).isEmpty
        let notFile: [UTType] = [.memryNote, .memryTasks]
        let isLink = types.contains { $0.conforms(to: .url) } && !carriesFile
        guard !isLink, !types.contains(where: { type in notFile.contains { type.conforms(to: $0) } }) else { return nil }
        if let text = types.first(where: { $0.conforms(to: .text) }) {
            return carriesFile ? text : nil
        }
        return types.first { $0.conforms(to: .data) && !$0.conforms(to: .url) }
    }
}

extension EditorSuggestions {
    /// The `[[` menu's row for the note `noteId`: its link target, a path
    /// where its title is shared, as `wiki(query:notes:)` answers it.
    static func link(to noteId: String, in notes: [NoteSummary]) -> EditorSuggestion.Kind? {
        guard let note = notes.first(where: { $0.id == noteId }) else { return nil }
        let ranked = wikiLinkCandidates(query: note.title, notes: notes, limit: UInt32(notes.count))
        return ranked.candidates.first { $0.noteId == noteId }.map { .note(title: $0.linkTarget, alias: "") }
    }
}

extension EditorSession {
    /// A wiki link to each dropped note, at `location` (UTF-16) in `field`,
    /// through the `[[` menu's insert, with the caret after them so the
    /// toolbar's undo and ⌘Z can take them back: the drag took the caret
    /// away. Typing not yet committed in the block is written first. A note
    /// this vault does not list, or one the drag could not hand over, is
    /// skipped, and the editor's alert says so.
    func dropNotes(_ providers: [NSItemProvider], at location: Int, in field: BlockField) async {
        let payloads = await NoteDrag.payloads(from: providers)
        let links = payloads.compactMap { EditorSuggestions.link(to: $0.noteId, in: linkNotes) }
        let dragged = providers.filter { $0.hasItemConformingToTypeIdentifier(UTType.memryNote.identifier) }.count
        if links.count < dragged {
            Log.storage.error("a note drop skipped notes this vault does not list", .count(dragged - links.count))
            failure = ErrorMapping.notesNotLinked(dragged - links.count)
        }
        guard !links.isEmpty else { return }
        if !field.textView.isFirstResponder { takeCaret(field, atEnd: false) }
        let storage = field.textView.textStorage
        var at = min(max(0, location), storage.length)
        // After a word, a space first, as the `@` button does (`startTrigger`).
        let before = at > 0 ? (storage.string as NSString).character(at: at - 1) : 32
        if ![32, 9, 10, 0xA0, 0xFFFC].contains(before) {
            storage.insert(NSAttributedString(string: " ", attributes: BlockText.baseAttributes(field.style)), at: at)
            at += 1
        }
        insertInline(links, replacing: NSRange(location: at, length: 0), in: field)
    }

    /// Notes dropped on the page off its lines: linked where the caret is,
    /// or was until the drag took it, else at the end of the last line
    /// drawn. `false` when no line on the page takes a link.
    func dropNotesOnPage(_ providers: [NSItemProvider]) -> Bool {
        let takesLinks = { (field: BlockField) in field.block.kind != "codeBlock" }
        let target: (field: BlockField, location: Int)? = if let field, drawnRow(field.blockId) === field, takesLinks(field) {
            (field, NSMaxRange(field.textView.selectedRange))
        } else {
            blocks().reversed().lazy.compactMap { $0.id.flatMap(self.drawnRow) }.first(where: takesLinks)
                .map { ($0, $0.textView.textStorage.length) }
        }
        guard model != nil, let target else { return false }
        Task { await dropNotes(providers, at: target.location, in: target.field) }
        return true
    }
}

/// The note page's drop: a note dropped anywhere on it that no line takes.
struct NotePageDrop: ViewModifier {
    let session: EditorSession

    func body(content: Content) -> some View {
        content.onDrop(of: [.memryNote], isTargeted: nil) { session.dropNotesOnPage($0) }
    }
}

extension BlockField: UITextDropDelegate, UIDropInteractionDelegate {
    /// The text view's own drop, which notes and Safari's pictures reach,
    /// and a second one for files it refuses.
    func installDrops() {
        textView.textDropDelegate = self
        textView.addInteraction(UIDropInteraction(delegate: self))
    }

    /// What a drop on this block does, or `nil` for the text view's own.
    private func editorDrop(_ session: UIDropSession) -> EditorDrop? {
        EditorDrop.of(session.items.map(\.itemProvider))
    }

    /// Whether this note takes files: not in a vault with no sync session,
    /// where the paperclip is hidden too.
    private var takesFiles: Bool { session?.attachDropped != nil }

    // MARK: Notes, and files the text view takes

    func textDroppableView(
        _ textDroppableView: UIView & UITextDroppable, proposalForDrop drop: UITextDropRequest
    ) -> UITextDropProposal {
        guard let kind = editorDrop(drop.dropSession) else { return drop.suggestedProposal }
        // Where files are not taken, a picture from Safari is the text
        // view's own drop, as before files were.
        if kind == .files, !takesFiles { return drop.suggestedProposal }
        // A code block's text stays literal: no link node goes in.
        if kind == .notes, block.kind == "codeBlock" || session?.model == nil {
            return UITextDropProposal(operation: .forbidden)
        }
        let proposal = UITextDropProposal(operation: .copy)
        proposal.dropPerformer = .delegate
        return proposal
    }

    func textDroppableView(_ textDroppableView: UIView & UITextDroppable, willPerformDrop drop: UITextDropRequest) {
        guard let kind = editorDrop(drop.dropSession) else { return }
        let providers = drop.dropSession.items.map(\.itemProvider)
        switch kind {
        case .notes:
            let location = textView.offset(from: textView.beginningOfDocument, to: drop.dropPosition)
            Task { await session?.dropNotes(providers, at: location, in: self) }
        case .files:
            session?.attachDropped?(providers, blockId)
        }
    }

    // MARK: Files the text view refuses

    /// Only a drop the text view's own interaction refuses, so one drag never
    /// has two targets on the same block.
    func dropInteraction(_ interaction: UIDropInteraction, canHandle session: UIDropSession) -> Bool {
        guard editorDrop(session) == .files else { return false }
        let own = textView.interactions.lazy.compactMap { $0 as? UIDropInteraction }.first { $0.delegate !== self }
        guard let own else { return true }
        return own.delegate?.dropInteraction?(own, canHandle: session) != true
    }

    /// Refused where files are not taken, so the drag shows it will not land.
    func dropInteraction(_ interaction: UIDropInteraction, sessionDidUpdate session: UIDropSession) -> UIDropProposal {
        UIDropProposal(operation: takesFiles ? .copy : .forbidden)
    }

    func dropInteraction(_ interaction: UIDropInteraction, performDrop session: UIDropSession) {
        self.session?.attachDropped?(session.items.map(\.itemProvider), blockId)
    }
}
