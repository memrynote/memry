import SwiftUI

// JP047, the Day page's "…" menu (J09): Find in page, Export…, Journal
// Settings. Desktop's menu is `JournalHeaderActions`
// (`components/journal/journal-header-actions.tsx`): Export only when the day
// has an entry, a separator, then Journal Settings. Version history and full
// width are desktop-only.
//
// The label is a bare ellipsis at the 44pt floor: the Day page puts it in its
// toolbar next to the bell, where the system draws the shared Liquid Glass
// capsule J09 shows (and the solid fallback under Reduce Transparency).
struct JournalMoreMenu: View {
    let store: JournalStore
    let date: String
    /// The day as plain text, for Export (note export, D1 title).
    let exportText: String
    /// Shows the page's find bar.
    let find: () -> Void

    @Environment(JournalRouter.self) private var router

    var body: some View {
        Menu {
            Button(JournalCopy.findInPage, systemImage: "magnifyingglass", action: find)
                .accessibilityIdentifier("journal.more.find")
            if store.cachedDay(date) != nil {
                let export = Self.noteExport(date: date, text: exportText)
                ShareLink(
                    item: export.contents,
                    subject: Text(export.title),
                    preview: SharePreview(export.filename)
                ) {
                    Label(JournalCopy.export, systemImage: "square.and.arrow.up")
                }
                .accessibilityLabel(JournalCopy.exportAccessibilityLabel)
                .accessibilityIdentifier("journal.more.export")
            }
            Divider()
            Button(JournalCopy.journalSettings, systemImage: "gearshape") {
                router.openSettings()
            }
            .accessibilityIdentifier("journal.more.settings")
        } label: {
            Label(JournalCopy.moreOptions, systemImage: "ellipsis")
                .labelStyle(.iconOnly)
                .frame(minWidth: Tokens.Size.minimumHitArea, minHeight: Tokens.Size.minimumHitArea)
                .contentShape(.rect)
        }
        .accessibilityLabel(JournalCopy.moreOptions)
        .accessibilityIdentifier("journal.more")
    }

    /// The exported file: desktop's `export.noteTitle` ("Journal - June 15,
    /// 2099") over the day's text, through the note export (D1).
    static func noteExport(date: String, text: String) -> NoteExport {
        let (year, month) = JournalDates.yearMonth(date)
        let title = JournalCopy.exportTitle(month: month, day: JournalDates.day(date), year: year)
        return NoteExport(title: title, text: text)
    }
}
