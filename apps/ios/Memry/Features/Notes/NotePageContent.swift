import MemryCore
import PhotosUI
import SwiftUI

// JP033 (spec 005-journal). The parts of a note page under its title, shared
// by the note screen and the journal day page, so the day page composes the
// note page rather than forking it: the tags and properties rows (with the
// ghost row), the body as editable blocks, review comments, backlinks and
// linked tasks. What differs between the two pages is passed in: what an
// empty body says, and what sits between the backlinks and the linked tasks
// (a note's reminders; nothing on a day, whose reminders live on the bell).
//
// Moved verbatim from `NoteReadView`; the note screen draws exactly what it
// drew before.

struct NotePageContent<EmptyBody: View, AfterBacklinks: View>: View {
    let model: NoteReadViewModel
    let detail: NoteDetail
    let editorModel: NoteEditorViewModel
    let metadataModel: NoteMetadataViewModel
    let composer: NoteAttachmentComposer
    let backlinks: BacklinksViewModel
    let linkedTasks: LinkedTasksViewModel
    let taskBridge: NoteTaskBridge
    /// Pushes another note. `nil` leaves links drawn but inert.
    let open: ((NoteRoute) -> Void)?
    let openTag: ((String) -> Void)?
    @Binding var brokenLink: String?
    /// What the page says when it has no blocks to draw.
    @ViewBuilder let emptyBody: (NoteBodyPreview) -> EmptyBody
    @ViewBuilder let afterBacklinks: () -> AfterBacklinks

    /// The keyboard toolbar's paperclip source being shown (N214's upload path).
    @State private var attaching: EditorAttachmentSource?

    /// The editing bridge, or `nil` on a read-only page.
    private var editing: NoteEditingBridge? {
        guard editorModel.canEdit else { return nil }
        // Re-read after a write so the block shows the document rather than
        // only the draft.
        let bridge = NoteEditingBridge(
            model: editorModel,
            titles: model.vaultNotes.map(\.title),
            icons: Dictionary(
                model.vaultNotes.compactMap { note in ProjectIconValue.emoji(note.emoji).map { (note.title.lowercased(), $0) } },
                uniquingKeysWith: { first, _ in first }
            ),
            titleExists: model.titleExists,
            pickImage: composer.canUpload ? { attaching = .photos } : nil
        ) { await model.reload() }
        let session = bridge.session
        session.tags = model.vaultTagNames
        session.tagColors = model.tagColors
        session.blocks = { model.blocks }
        let noteId = detail.summary.id
        session.relinkTask = taskBridge.relink.map { relink in
            { taskId, target in await relink(taskId, noteId, target) }
        }
        // Assigned only when it appears or goes, so drawing does not keep
        // invalidating the toolbar that observes it.
        if (session.attach == nil) == composer.canUpload {
            session.attach = composer.canUpload ? { attaching = $0 } : nil
        }
        return bridge
    }

    var body: some View {
        // Under the title and above the body, which is where desktop puts
        // them and where a reader looks for what a note *is* before reading
        // what it says. Absent until the read answers, and absent again when
        // there is nothing.
        if let metadata = model.metadata {
            if metadataModel.canEdit {
                NoteMetadataEditors(
                    metadata: metadata,
                    model: metadataModel,
                    reload: { await model.reload() },
                    noteTitle: { id in model.vaultNotes.first { $0.id == id }?.title },
                    noteIcon: { id in model.vaultNotes.first { $0.id == id }?.emoji },
                    tagColors: model.tagColors,
                    tagSuggestions: model.vaultTagNames,
                    relationCandidates: model.vaultNotes
                )
            } else {
                NoteMetaView(metadata: metadata)
            }
        }
        if model.blocks.isEmpty {
            // No blocks to draw. Which of the three reasons it is — never
            // pulled, genuinely empty, or a walk that failed — is the
            // caller's to say.
            emptyBody(NoteBodyPreview.of(detail.body))
        } else {
            // With no stack to push onto (`open` is nil) the links are still
            // drawn and readable; they lead nowhere.
            NoteBlocksView(
                blocks: model.blocks,
                openTarget: open.map { open in
                    { title in
                        // Resolved on the tap, then pushed onto the stack the
                        // browse list pushes onto. A link naming no note says
                        // so rather than doing nothing; desktop offers to
                        // create it.
                        Task {
                            if let route = await model.wikiTarget(for: title) {
                                open(route)
                            } else {
                                brokenLink = title
                            }
                        }
                    }
                },
                openTag: openTag,
                tableContent: { model.tables[$0] },
                attachment: { model.attachments[$0] ?? .unknown },
                removeAttachment: { id in
                    if await composer.detach(attachmentId: id) {
                        await model.refreshAttachments()
                    }
                },
                editing: editing,
                tableEditing: editorModel.canEdit
                    ? NoteTableEditing(editor: editorModel) { await model.reload() }
                    : nil
            )
            .modifier(EditorAttachmentSources(source: $attaching, composer: composer, session: editorModel.session))
            .modifier(MoveBlockPresenter(session: editorModel.session, notes: model.vaultNotes, currentNoteId: detail.summary.id))
        }
        // Read only (N604): §12.5.1 forbids writing them.
        ReviewCommentsSection(comments: model.comments)
        // Under the body, where desktop puts it and where a reader looks
        // after finishing the note (N800).
        if let open {
            BacklinksSection(model: backlinks, open: open)
        }
        afterBacklinks()
        LinkedTasksSection(model: linkedTasks, open: taskBridge.open)
    }
}

/// The environment a note page's blocks read: which titles exist, the task
/// cards, the task bridge and the review marks.
struct NotePageEnvironment: ViewModifier {
    let model: NoteReadViewModel
    let taskBridge: NoteTaskBridge

    func body(content: Content) -> some View {
        content
            .environment(\.noteTitleExists, model.titleExists)
            .environment(\.taskCards, model.taskCards)
            .environment(\.noteTasks, taskBridge)
            .environment(
                \.reviewMarks,
                ReviewMarkStyle.unambiguous(model.comments, in: model.exportText)
            )
    }
}
