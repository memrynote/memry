import MemryCore
import SwiftUI

// JP040 (J01, J02, J03, J10). One day's page: the date header over its fog,
// then the note page's parts through `NotePageContent` (tags and properties,
// the body as editable blocks, review comments, backlinks, linked tasks),
// then the Day section and the stats footer. An empty day offers its
// placeholder as an editable first line; a day whose body is not on this
// phone shows the note page's fetch state, never an empty entry.

struct JournalDayPage: View {
    let store: JournalStore
    let date: String
    let model: JournalDayPageModel?
    /// Whether this page is the one on screen (only it seeds and drives the
    /// inline title).
    let isShown: Bool
    /// Pushes a note, or shows a day for a journal id.
    let open: (NoteRoute) -> Void
    @Binding var titleCollapsed: Bool

    @Environment(TasksRouter.self) private var tasksRouter: TasksRouter?
    @Environment(\.requestVaultSync) private var requestVaultSync
    @State private var brokenLink: String?

    private var hour: Int {
        JournalDates.calendar.component(.hour, from: store.clock.instant())
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Tokens.Space.section) {
                JournalDayHeader(date: date, today: store.clock.today, hour: hour)
                if let model {
                    content(model)
                } else {
                    loading
                }
                JournalDaySection(store: store, date: date)
                JournalStatsFooter(day: store.cachedDay(date), vaultId: store.vaultId)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, Tokens.Space.screenInline)
            .padding(.vertical, Tokens.Space.medium)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(Tokens.Canvas.background.color)
        .onScrollGeometryChange(for: Bool.self) { geometry in
            geometry.contentOffset.y + geometry.contentInsets.top > Tokens.Size.minimumHitArea * 2
        } action: { _, collapsed in
            if isShown { titleCollapsed = collapsed }
        }
        .safeAreaInset(edge: .top) {
            if let model, model.finding { findPanel(model) }
        }
        .task(id: model == nil) {
            guard let model else { return }
            await model.read.loadIfNeeded()
            await model.read.fetchWaitingAttachments()
        }
        .task(id: isShown && model != nil) {
            if isShown { await model?.seedIfNeeded(store: store) }
        }
        .task(id: PullKey(shown: isShown && model != nil, pass: store.syncPasses)) {
            if isShown { await model?.pullRemoteBody(store: store) }
        }
        .onChange(of: store.generation) {
            // A write or a sync pass changed something: re-read in place.
            Task {
                await model?.read.reload()
                await model?.backlinks.reload()
            }
        }
        .onChange(of: model?.read.phase) { _, phase in
            if case let .ready(detail) = phase { model?.lastDetail = detail }
        }
        .accessibilityIdentifier("journal.day.page.\(date)")
    }

    private var loading: some View {
        ProgressView { Text(JournalCopy.loadingDay) }
            .progressViewStyle(.circular)
            .font(Tokens.Typography.supporting.font)
            .tint(Tokens.Text.secondary.color)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func content(_ model: JournalDayPageModel) -> some View {
        if let detail = model.detail {
            let taskBridge = taskBridge(model)
            VStack(alignment: .leading, spacing: Tokens.Space.section) {
                if !JournalWriteGate.metadataWrites {
                    JournalDayReadOnlyMetadata(
                        metadata: JournalNoteBridge.metadata(store.cachedDay(date)),
                        explains: Bindable(model).explainsReadOnlyMetadata
                    )
                }
                NotePageContent(
                    model: model.read,
                    detail: detail,
                    editorModel: model.editor,
                    metadataModel: model.metadata,
                    composer: model.composer,
                    backlinks: model.backlinks,
                    linkedTasks: model.linkedTasks,
                    taskBridge: taskBridge,
                    // A day with no entry has nothing linking to it worth a
                    // section (Paper J01, J10); `nil` hides the backlinks.
                    open: store.cachedDay(date) == nil ? nil : open,
                    openTag: nil,
                    brokenLink: $brokenLink,
                    emptyBody: { preview in emptyBody(preview, model: model) },
                    afterBacklinks: { EmptyView() }
                )
            }
            .modifier(NotePageEnvironment(model: model.read, taskBridge: taskBridge))
            // The note page's own copy for a link naming no note.
            .alert(
                "There is no note called \u{201c}\(brokenLink ?? "")\u{201d}",
                isPresented: Binding(get: { brokenLink != nil }, set: { if !$0 { brokenLink = nil } })
            ) {
                Button("OK", role: .cancel) { brokenLink = nil }
            } message: {
                Text("The link points at a note this vault does not hold. You can create it on your computer.")
            }
        } else {
            switch model.read.phase {
            case let .unreadable(error):
                ErrorNotice(error: error, code: nil)
                Button(JournalCopy.tryAgain) { Task { await model.read.reload() } }
                    .memrySecondaryAction()
                    .accessibilityIdentifier("journal.day.retry")
            case .missing:
                NoteMissingNotice()
            case .loading, .ready:
                loading
            }
        }
    }

    /// An empty body is the placeholder line; anything else is the note
    /// page's own body state (not on this phone, with its fetch button).
    @ViewBuilder
    private func emptyBody(_ preview: NoteBodyPreview, model: JournalDayPageModel) -> some View {
        if case .empty = preview {
            JournalDayFirstLine(
                placeholder: JournalCopy.placeholder(date: date, today: store.clock.today)
            ) { line in
                await model.writeFirstLine(line)
            }
        } else {
            NoteBodyView(
                preview: preview,
                fetch: model.read.fetch,
                download: model.read.canFetchBody ? { Task { await model.read.fetchBody() } } : nil
            )
        }
    }

    private func taskBridge(_ model: JournalDayPageModel) -> NoteTaskBridge {
        .note(tasks: model.taskActions, editor: model.editor, router: tasksRouter) {
            requestVaultSync?()
            await model.read.reload()
            await model.linkedTasks.load()
        }
    }

    private func findPanel(_ model: JournalDayPageModel) -> some View {
        VStack(alignment: .leading, spacing: Tokens.Space.small) {
            HStack {
                Spacer()
                Button {
                    model.finding = false
                } label: {
                    Image(systemName: "xmark")
                        .frame(width: Tokens.Size.minimumHitArea, height: Tokens.Size.minimumHitArea)
                        .contentShape(.rect)
                }
                .accessibilityLabel(JournalCopy.closeFind)
                .accessibilityIdentifier("journal.day.find.close")
            }
            NoteFindView(blocks: model.read.blocks)
        }
        .padding(.horizontal, Tokens.Space.screenInline)
        .padding(.bottom, Tokens.Space.small)
        .background(Tokens.Canvas.background.color)
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(Tokens.Line.border.color)
                .frame(height: Tokens.Size.hairline)
        }
    }
}

/// When the shown day pulls its remote body: on becoming shown, and after
/// each sync pass while shown.
private struct PullKey: Equatable {
    let shown: Bool
    let pass: Int
}
