import MemryCore
import SwiftUI

// JP047, the Day page's "…" menu (J09), grouped as the note page's is:
// looking around the day (Find, Backlinks), organising it (Favorite,
// Reminder), taking it elsewhere (Share, Export), Journal Settings, and
// Delete last. Desktop's menu is `JournalHeaderActions`
// (`components/journal/journal-header-actions.tsx`): Export only when the day
// has an entry, a separator, then Journal Settings. Version history and full
// width are desktop-only; icon, cover, move and duplicate are note-only (a
// journal payload carries no icon or cover, and a day has no folder).
//
// The label is a bare ellipsis at the 44pt floor: the Day page puts it in its
// toolbar next to the bell, where the system draws the shared Liquid Glass
// capsule J09 shows (and the solid fallback under Reduce Transparency).
struct JournalMoreMenu: View {
    let store: JournalStore
    let date: String
    /// The day as plain text, for Share and Export (note export, D1 title).
    let exportText: String
    /// Shows the page's find bar.
    let find: () -> Void
    /// The days and notes linking here; `nil` until the page is built.
    let backlinks: BacklinksViewModel?
    /// Opens a backlink: a day in place, a note pushed.
    let open: (NoteRoute) -> Void

    @Environment(JournalRouter.self) private var router
    @Environment(\.journalTasks) private var tasks
    @Environment(\.requestVaultSync) private var requestVaultSync
    @State private var isFavorite = false
    @State private var reminderSheet: JournalBellSheet?
    @State private var showingBacklinks = false
    @State private var confirmingDelete = false

    /// The day's record id: favorites and backlinks name a day by it.
    private var entryId: String? { store.cachedDay(date)?.id }
    private var writer: (any NotesWriting)? { store.context?.writer }

    var body: some View {
        Menu {
            Section {
                Button(JournalCopy.findInPage, systemImage: "magnifyingglass", action: find)
                    .accessibilityIdentifier("journal.more.find")
                if let backlinks {
                    Button(JournalCopy.backlinks, systemImage: "arrow.down.left") {
                        showingBacklinks = true
                        Task { await backlinks.reload() }
                    }
                    .accessibilityIdentifier("journal.more.backlinks")
                }
            }
            Section {
                if writer != nil, entryId != nil {
                    Button(action: toggleFavorite) {
                        if isFavorite {
                            Label(JournalCopy.removeFromFavorites, systemImage: "star.slash")
                        } else {
                            Label(JournalCopy.addToFavorites, systemImage: "star")
                        }
                    }
                    .accessibilityIdentifier("journal.more.favorite")
                }
                Button(JournalCopy.reminder, systemImage: "bell") {
                    reminderSheet = JournalBellSheet.forDay(store, date)
                }
                .accessibilityIdentifier("journal.more.reminder")
            }
            if entryId != nil {
                let export = Self.noteExport(date: date, text: exportText)
                Section {
                    ShareLink(item: export.contents, subject: Text(export.title)) {
                        Label(JournalCopy.share, systemImage: "square.and.arrow.up")
                    }
                    .accessibilityIdentifier("journal.more.share")
                    ShareLink(
                        item: NoteExportFile(export: export),
                        preview: SharePreview(export.filename)
                    ) {
                        Label(JournalCopy.export, systemImage: "arrow.down.doc")
                    }
                    .accessibilityLabel(JournalCopy.exportAccessibilityLabel)
                    .accessibilityIdentifier("journal.more.export")
                }
            }
            Section {
                Button(JournalCopy.journalSettings, systemImage: "gearshape") {
                    router.openSettings()
                }
                .accessibilityIdentifier("journal.more.settings")
            }
            if entryId != nil {
                Section {
                    Button(JournalCopy.deleteDay, systemImage: "trash", role: .destructive) {
                        confirmingDelete = true
                    }
                    .accessibilityIdentifier("journal.more.delete")
                }
            }
        } label: {
            Label(JournalCopy.moreOptions, systemImage: "ellipsis")
                .labelStyle(.iconOnly)
                .frame(minWidth: Tokens.Size.minimumHitArea, minHeight: Tokens.Size.minimumHitArea)
                .contentShape(.rect)
        }
        .accessibilityLabel(JournalCopy.moreOptions)
        .accessibilityIdentifier("journal.more")
        .task(id: entryId) { await loadFavorite() }
        .sheet(item: $reminderSheet) { sheet in
            JournalBellSheetContent(sheet: sheet, store: store, date: date, tasks: tasks) {
                reminderSheet = nil
            }
        }
        .sheet(isPresented: $showingBacklinks) {
            if let backlinks {
                NoteBacklinksSheet(model: backlinks) { route in
                    showingBacklinks = false
                    open(route)
                }
            }
        }
        .confirmationDialog(
            JournalCopy.deleteDayTitle,
            isPresented: $confirmingDelete,
            titleVisibility: .visible
        ) {
            Button(JournalCopy.deleteDay, role: .destructive) {
                Task { await store.perform(date: date) { try $0.deleteDay(date: date) } }
            }
            Button(JournalCopy.keep, role: .cancel) {}
        } message: {
            Text(JournalCopy.deleteDayMessage)
        }
    }

    private func loadFavorite() async {
        guard let writer, let entryId else {
            isFavorite = false
            return
        }
        isFavorite = (try? await writer.isBookmarked(itemType: "journal", itemId: entryId)) ?? false
    }

    private func toggleFavorite() {
        guard let writer, let entryId else { return }
        Task {
            do {
                isFavorite = try await writer.toggleBookmark(itemType: "journal", itemId: entryId)
                requestVaultSync?()
            } catch {
                store.report(error)
            }
        }
    }

    /// The exported file: desktop's `export.noteTitle` ("Journal - June 15,
    /// 2099") over the day's text, through the note export (D1).
    static func noteExport(date: String, text: String) -> NoteExport {
        let (year, month) = JournalDates.yearMonth(date)
        let title = JournalCopy.exportTitle(month: month, day: JournalDates.day(date), year: year)
        return NoteExport(title: title, text: text)
    }
}
