import MemryCore
import SwiftUI

// The Month screen (J05). Placeholder until JP043 lands.
struct JournalMonthScreen: View {
    let store: JournalStore
    let year: Int
    let month: Int
    @Environment(JournalRouter.self) private var router

    var body: some View {
        List(store.month(year: year, month: month)?.days ?? [], id: \.date) { day in
            Button(day.date) { router.showDay(day.date) }
        }
        .navigationTitle(JournalCopy.monthName(month))
        .task { await store.loadMonth(year: year, month: month) }
    }
}
