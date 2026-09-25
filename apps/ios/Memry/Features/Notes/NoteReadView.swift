import Foundation
import MemryCore
import SwiftUI

// One note: its cover, title and metadata, the body as blocks, and the
// sections under it (review, backlinks, reminders, tasks).
//
// This began as T157's read-only text preview; the body is now the core's
// block list drawn by `NoteBlocksView`, and a vault with a signing identity
// edits it in place. The preview (`NoteBodyView`) remains only for a note
// whose blocks are not on this phone.
//
// **Tokens only** (T160): no font, colour, spacing or radius literal appears
// here. Logical edges, Dynamic Type from the type roles, and reduce-motion
// branched inside `calmAnimation` on every evaluation.

struct NoteReadView: View {
    @State private var model: NoteReadViewModel

    /// The production entry point. `NotesListView.body`'s one
    /// `navigationDestination(for: NoteRoute.self)` calls exactly this, with
    /// the browse model's own reader — which on the production graph is
    /// `CoreNotesReader` over the shell's serial core queue.
    ///
    /// `State(initialValue:)` so the model outlives a re-render: a model minted
    /// in `body` would re-read the note, and its CRDT apply, every frame.
    /// Pushes another note onto the enclosing stack.
    ///
    /// Handed down rather than declared here: the destination stays registered
    /// once, on `NotesListView.body`, because a `navigationDestination`
    /// declared beside a lazily-realised row is registered only once that row
    /// has been drawn, and a restored path would then resolve against a stack
    /// that never heard of the route (research R15).
    ///
    /// `nil` for a caller with no stack — a preview, or a test rendering this
    /// screen alone. Wiki links then draw as links and go nowhere, which is
    /// the truth about that context.
    private let open: ((NoteRoute) -> Void)?
    /// Where a `#tag` goes (N600). `nil` leaves tags marked but inert.
    private let openTag: ((String) -> Void)?

    init(
        route: NoteRoute,
        reader: any NotesReading,
        filler: (any VaultFilling)? = nil,
        editor: (any BlockEditing)? = nil,
        metadataWriter: (any NoteMetadataWriting)? = nil,
        writer: (any NotesWriting)? = nil,
        search: (any VaultSearching)? = nil,
        open: ((NoteRoute) -> Void)? = nil,
        openTag: ((String) -> Void)? = nil,
        noteTasks: (any NoteTaskWriting)? = nil
    ) {
        self.open = open
        self.openTag = openTag
        _actions = State(initialValue: NotePageActions(noteId: route.id, writer: writer))
        _backlinks = State(
            initialValue: BacklinksViewModel(noteId: route.id, search: search)
        )
        _reminders = State(
            initialValue: NoteRemindersViewModel(
                noteId: route.id, reader: reader, writer: writer
            )
        )
        _linkedTasks = State(
            initialValue: LinkedTasksViewModel(noteId: route.id, reader: reader)
        )
        _taskActions = State(initialValue: NoteTaskActions(noteId: route.id, tasks: noteTasks))
        _model = State(
            initialValue: NoteReadViewModel(
                route: route,
                reader: reader,
                filler: filler,
                reachability: PathReachability.forAttachments
            )
        )
        _composer = State(
            initialValue: NoteAttachmentComposer(noteId: route.id, filler: filler)
        )
        _editorModel = State(
            initialValue: NoteEditorViewModel(noteId: route.id, editor: editor)
        )
        _metadataModel = State(
            initialValue: NoteMetadataViewModel(noteId: route.id, writer: metadataWriter)
        )
    }

    init(
        model: NoteReadViewModel,
        editor: (any BlockEditing)? = nil,
        metadataWriter: (any NoteMetadataWriting)? = nil,
        writer: (any NotesWriting)? = nil,
        search: (any VaultSearching)? = nil,
        open: ((NoteRoute) -> Void)? = nil,
        openTag: ((String) -> Void)? = nil,
        noteTasks: (any NoteTaskWriting)? = nil
    ) {
        self.open = open
        self.openTag = openTag
        _actions = State(initialValue: NotePageActions(noteId: model.route.id, writer: writer))
        _backlinks = State(
            initialValue: BacklinksViewModel(noteId: model.route.id, search: search)
        )
        _reminders = State(
            initialValue: NoteRemindersViewModel(
                noteId: model.route.id, reader: model.reader, writer: writer
            )
        )
        _linkedTasks = State(
            initialValue: LinkedTasksViewModel(noteId: model.route.id, reader: model.reader)
        )
        _taskActions = State(
            initialValue: NoteTaskActions(noteId: model.route.id, tasks: noteTasks)
        )
        _model = State(initialValue: model)
        _composer = State(
            initialValue: NoteAttachmentComposer(noteId: model.route.id, filler: model.filler)
        )
        _editorModel = State(
            initialValue: NoteEditorViewModel(noteId: model.route.id, editor: editor)
        )
        _metadataModel = State(
            initialValue: NoteMetadataViewModel(noteId: model.route.id, writer: metadataWriter)
        )
    }

    /// The body write surface. Read-only when absent.
    @State private var editorModel: NoteEditorViewModel

    /// The metadata write surface. Read-only when absent.
    @State private var metadataModel: NoteMetadataViewModel

    /// Adds and removes this note's attachments.
    @State private var composer: NoteAttachmentComposer

    /// The title of a wiki link that resolved to nothing, for the notice.
    @State private var brokenLink: String?

    /// This session's undo history (N509).
    @State private var history = EditorUndoStack()

    /// The page menu's three write actions (N808).
    @State private var actions: NotePageActions

    /// The notes linking here (N800).
    @State private var backlinks: BacklinksViewModel

    /// What is set to remind the reader about this note (N804).
    @State private var reminders: NoteRemindersViewModel

    /// The tasks linked to this note (N807).
    @State private var linkedTasks: LinkedTasksViewModel

    /// Ticking task lines and converting checklist items (TP054).
    @State private var taskActions: NoteTaskActions
    /// Opens a task in the Tasks tab. Absent outside the vault shell.
    @Environment(TasksRouter.self) private var router: TasksRouter?
    @Environment(\.requestVaultSync) private var requestVaultSync

    private var taskBridge: NoteTaskBridge {
        .note(tasks: taskActions, editor: editorModel, router: router) {
            requestVaultSync?()
            await model.reload()
            await linkedTasks.load()
        }
    }

    /// The page menu's sheets and alert (N808).
    @State private var renaming = false
    @State private var renameDraft = ""
    @State private var moving = false
    @State private var confirmingDelete = false
    /// Find in note (N801), shown on demand rather than always.
    @State private var finding = false

    /// Applies one direction of an undo step.
    ///
    /// The step is already off its stack by the time this runs, so a failure
    /// is reported and the stacks are left as they are rather than trying to
    /// put it back — a half-restored history is harder to reason about than
    /// one that simply did not move.
    private func applyHistory(_ edit: BlockEdit?) async {
        guard let edit else { return }
        await editorModel.apply(edit)
        await model.reload()
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Tokens.Space.section) {
                switch model.phase {
                case .loading:
                    // Words, never a bare spinner, and never a duration.
                    ProgressView { Text("Reading this note") }
                        .progressViewStyle(.circular)
                        .font(Tokens.Typography.supporting.font)
                        .tint(Tokens.Text.secondary.color)
                        .frame(maxWidth: .infinity, alignment: .leading)
                case .missing:
                    NoteMissingNotice()
                case let .unreadable(error):
                    ErrorNotice(error: error, code: nil)
                    Button("Try again") { Task { await model.reload() } }
                        .memrySecondaryAction()
                case let .ready(detail):
                    // The cover sits above everything, as desktop puts it.
                    // Render-only: `coverImage` is an unknown payload key, so
                    // this draws what another client wrote and offers no way
                    // to author one (research.md).
                    NoteCoverView(
                        cover: NoteCover.of(model.metadata?.coverJson),
                        resolve: { model.attachments[$0] ?? .unknown }
                    )
                    if metadataModel.canEdit {
                        NoteTitleEditor(
                            title: model.displayTitle,
                            icon: model.metadata?.icon,
                            canEdit: true,
                            rename: { title in
                                Task {
                                    await metadataModel.rename(
                                        to: title, current: model.displayTitle
                                    )
                                    await model.reload()
                                }
                            },
                            setIcon: { icon in
                                Task {
                                    await metadataModel.setIcon(icon)
                                    await model.reload()
                                }
                            }
                        )
                    } else {
                        NoteHeader(title: model.displayTitle, summary: detail.summary)
                    }
                    NotePageContent(
                        model: model,
                        detail: detail,
                        editorModel: editorModel,
                        metadataModel: metadataModel,
                        composer: composer,
                        backlinks: backlinks,
                        linkedTasks: linkedTasks,
                        taskBridge: taskBridge,
                        open: open,
                        openTag: openTag,
                        brokenLink: $brokenLink,
                        emptyBody: { preview in
                            NoteBodyView(
                                preview: preview,
                                fetch: model.fetch,
                                download: model.canFetchBody ? { Task { await model.fetchBody() } } : nil
                            )
                        },
                        afterBacklinks: {
                            // N804, under the backlinks: both are about the
                            // note rather than in it.
                            NoteRemindersSection(model: reminders)
                        }
                    )
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, Tokens.Space.screenInline)
            .padding(.vertical, Tokens.Space.screenBlock)
        }
        .background(Tokens.Canvas.background.color)
        .modifier(NotePageEnvironment(model: model, taskBridge: taskBridge))
        .calmAnimation(.normal, value: model.phase)
        // This screen carries its own bottom toolbar (link and date menus,
        // undo/redo). Left showing, the platform tab bar renders underneath
        // it as a second glass surface, and the two composite into a
        // ghosted overlap of icons behind the tab bar's own. A pushed note
        // hides the tab bar, as a detail screen does everywhere else on
        // this OS, so exactly one bottom bar is on screen at a time.
        .toolbar(.hidden, for: .tabBar)
        .modifier(
            NoteReadToolbar(
                model: model,
                editorModel: editorModel,
                metadataModel: metadataModel,
                actions: actions,
                composer: composer,
                history: history,
                renaming: $renaming,
                moving: $moving,
                confirmingDelete: $confirmingDelete,
                applyHistory: applyHistory,
                export: NoteExport(
                    title: model.displayTitle,
                    text: model.exportText
                )
            )
        )
        .modifier(
            NoteReadDialogs(
                model: model,
                actions: actions,
                taskActions: taskActions,
                renaming: $renaming,
                renameDraft: $renameDraft,
                moving: $moving,
                confirmingDelete: $confirmingDelete,
                brokenLink: $brokenLink
            )
        )
        .task {
            await model.loadIfNeeded()
            // After the body and its bindings are on screen, not before: the
            // placeholders are what FR-045 asks to be visible first, and a
            // fetch that finished early would still only re-render them.
            await model.fetchWaitingAttachments()
        }
    }
}
