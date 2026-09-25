import SwiftUI

// JP042. The Day page's title menu (Paper J04): Month ("September 2026"),
// Year ("2026"), then Go to date…, which opens a graphical date picker.
// Desktop's breadcrumb (`date-breadcrumb.tsx`) offers the same three ways
// up and across.
//
// `journalTitleMenu(store:date:)` hangs the menu on the inline navigation
// title (`toolbarTitleMenu`) and owns the Go to date sheet. A large header
// drawn in the page's content can show the same menu with
// `Menu { JournalTitleMenu(date:) } label: { … }`; its Go to date row opens
// the modifier's sheet through `\.journalGoToDate`.

extension View {
    func journalTitleMenu(store: JournalStore, date: String) -> some View {
        modifier(JournalTitleMenuModifier(store: store, date: date))
    }
}

extension EnvironmentValues {
    /// Opens the Go to date sheet of the enclosing `journalTitleMenu`.
    @Entry var journalGoToDate: (@MainActor () -> Void)?
}

private struct JournalTitleMenuModifier: ViewModifier {
    let store: JournalStore
    let date: String

    @Environment(JournalRouter.self) private var router
    @State private var showsGoToDate = false

    func body(content: Content) -> some View {
        content
            .toolbarTitleMenu {
                JournalTitleMenu(date: date, goToDate: { showsGoToDate = true })
            }
            .environment(\.journalGoToDate) { showsGoToDate = true }
            .sheet(isPresented: $showsGoToDate) {
                JournalGoToDateSheet(date: date, today: store.today) { picked in
                    router.showDay(picked)
                }
            }
    }
}

/// The title menu's rows. Month and Year move up the stack; Go to date asks
/// the enclosing `journalTitleMenu` for its sheet.
struct JournalTitleMenu: View {
    let date: String
    /// Opens Go to date; `nil` uses the enclosing `journalTitleMenu`'s sheet.
    var goToDate: (@MainActor () -> Void)?

    @Environment(JournalRouter.self) private var router
    @Environment(\.journalGoToDate) private var enclosingGoToDate

    var body: some View {
        let (year, month) = JournalDates.yearMonth(date)
        Section {
            Button {
                router.openMonth(year: year, month: month)
            } label: {
                Label(JournalCopy.monthAndYear(year: year, month: month), systemImage: "calendar")
                Text(JournalCopy.month)
            }
            .accessibilityLabel("\(JournalCopy.month), \(JournalCopy.monthAndYear(year: year, month: month))")
            .accessibilityIdentifier("journal.titleMenu.month")
            Button {
                router.openYear(year)
            } label: {
                Label(String(year), systemImage: "square.grid.2x2")
                Text(JournalCopy.year)
            }
            .accessibilityLabel("\(JournalCopy.year), \(String(year))")
            .accessibilityIdentifier("journal.titleMenu.year")
        }
        if let goToDate = goToDate ?? enclosingGoToDate {
            Section {
                Button(JournalCopy.goToDate, systemImage: "calendar.circle") { goToDate() }
                    .accessibilityIdentifier("journal.titleMenu.goToDate")
            }
        }
    }
}
