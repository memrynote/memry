import MemryCore
import SwiftUI

// The Day page (J01-J03, J10). Placeholder until JP040 lands.
struct JournalDayScreen: View {
    let store: JournalStore
    let date: String

    var body: some View {
        Text(date)
            .navigationTitle(date)
            .task { await store.loadDay(date) }
    }
}
