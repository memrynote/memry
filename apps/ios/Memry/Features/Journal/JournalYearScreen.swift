import MemryCore
import SwiftUI

// The Year screen (J06). Placeholder until JP044 lands: it lists the months
// so the stack is navigable.
struct JournalYearScreen: View {
    let store: JournalStore
    @Environment(JournalRouter.self) private var router

    var body: some View {
        List(1 ... 12, id: \.self) { month in
            Button(JournalCopy.monthName(month)) { router.openMonth(year: router.rootYear, month: month) }
        }
        .navigationTitle(String(router.rootYear))
    }
}
