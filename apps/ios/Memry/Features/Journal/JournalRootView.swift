import MemryCore
import SwiftUI

// JP031. The Journal tab's content for one opened vault: the store's stack
// (Year › Month › Day) and what restores it. Opening the tab with no saved
// stack lands on today (desktop opens on today). The store is the vault's,
// built by `VaultJournalScope`.

/// The Journal tab: the store's screens, or why there are none.
struct JournalTabContent: View {
    @Environment(\.journalStore) private var store
    @Environment(\.journalStoreFailure) private var failure
    @Environment(\.journalTasks) private var tasksStore
    @Environment(JournalRouter.self) private var router
    @State private var capturing = false
    @Environment(\.quickCapture) private var capture

    var body: some View {
        Group {
            if let store {
                JournalRootView(store: store)
                    // Once for the tab: the Day screen keeps three pages
                    // alive, and each binding its own would present twice.
                    .modifier(JournalSubtaskPrompts(tasks: tasksStore))
                    .overlay(alignment: .bottom) {
                        HStack(spacing: Tokens.Space.medium) {
                            JournalToast(store: store)
                                .frame(maxWidth: .infinity)
                            // The page's own "+": a line on today's entry,
                            // through the same sheet Home captures with.
                            if capture != nil {
                                FloatingAddButton(
                                    label: QuickCaptureCopy.addToJournal,
                                    hint: QuickCaptureCopy.addToJournalHint,
                                    identifier: "journal.addButton"
                                ) { capturing = true }
                                .pickerPopover(isPresented: $capturing, size: PickerSize.short) {
                                    if let capture {
                                        QuickCaptureSheet(
                                            kinds: [.journal],
                                            capture: capture,
                                            draft: capture.journalDraft
                                        ) { receipt in
                                            router.openDay(receipt.id)
                                        }
                                    }
                                }
                            }
                        }
                        .padding(.horizontal, Tokens.Space.inset)
                        .padding(.bottom, Tokens.Space.medium)
                    }
            } else if let failure {
                NavigationStack {
                    ErrorNotice(error: failure, code: nil)
                        .padding(Tokens.Space.screenInline)
                        .navigationTitle(JournalCopy.title)
                }
            } else {
                ProgressView(JournalCopy.loading)
            }
        }
        // A route that arrived first (a reminder tap on a cold start) wins
        // over the saved stack; with neither, the tab opens on today.
        .onChange(of: store?.vaultId, initial: true) {
            guard let store, router.path.isEmpty else { return }
            let savedStack = LaunchSnapshot.shared.stack("journal").map { String(decoding: $0, as: UTF8.self) } ?? ""
            if !router.restore(savedStack) { router.showDay(store.clock.today) }
        }
        .onChange(of: router.saved) { _, saved in LaunchSnapshot.shared.setStack("journal", Data(saved.utf8)) }
    }
}

extension JournalTabContent {
    /// The note page's dependencies, built as `VaultBrowseViewModel` builds
    /// them for the Notes tab.
    static func context(
        vault: Vault,
        secureStore: any SecureStore,
        filler: (any VaultFilling)?
    ) -> JournalVaultContext {
        let executor = CoreExecutor.shared
        return JournalVaultContext(
            reader: CoreNotesReader(vault: vault, executor: executor),
            filler: filler,
            writer: CoreNotesWriter(vault: vault, store: secureStore, executor: executor),
            editor: CoreBlockEditor(vault: vault, store: secureStore, executor: executor),
            metadataWriter: CoreNoteMetadataWriter(vault: vault, store: secureStore, executor: executor),
            search: try? CoreVaultSearch(vault: vault, executor: executor),
            noteTasks: CoreNoteTasks(vault: vault, store: secureStore, executor: executor)
        )
    }
}

/// The stack: Year at the root, Month and Day pushed over it.
struct JournalRootView: View {
    let store: JournalStore
    @Environment(JournalRouter.self) private var router

    var body: some View {
        @Bindable var router = router
        NavigationStack(path: $router.path) {
            JournalYearScreen(store: store)
                .navigationDestination(for: JournalRoute.self) { route in
                    switch route {
                    case let .month(year, month):
                        JournalMonthScreen(store: store, year: year, month: month)
                    case let .day(date):
                        JournalDayScreen(store: store, date: date)
                    case .settings:
                        // A Settings page, opened from Settings › Journal.
                        JournalSettingsScreen(store: store)
                            .settingsPage()
                    case let .note(id):
                        if let context = store.context {
                            NoteReadView(
                                route: NoteRoute(id: id),
                                reader: context.reader,
                                filler: context.filler,
                                editor: context.editor,
                                metadataWriter: context.metadataWriter,
                                writer: context.writer,
                                search: context.search,
                                open: { router.path.append(.note($0.id)) },
                                noteTasks: context.noteTasks
                            )
                        }
                    }
                }
        }
        .onChange(of: store.clock.today) { old, new in
            // Midnight passed while the tab showed "today": follow it, as
            // desktop's day page does when the date changes under it.
            if router.shownDay == old { router.showDay(new) }
        }
    }
}
