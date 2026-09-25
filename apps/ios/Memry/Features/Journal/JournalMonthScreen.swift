import MemryCore
import SwiftUI

// JP043. The Month screen (Paper J05, desktop `journal-month-view.tsx`): the
// month's days newest first, a large serif title with "2026 · 17 entries ·
// 6-day streak" under it, ‹ › for the neighbouring months, and a tap that
// opens the day. Reads only (D2): an empty day is not created by showing it.

struct JournalMonthScreen: View {
    let store: JournalStore
    let year: Int
    let month: Int

    @Environment(JournalRouter.self) private var router
    @State private var titleCollapsed = false

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                JournalCalendarTitle(title: JournalCopy.monthName(month), subtitle: subtitle)
                    .padding(.horizontal, Tokens.Space.screenInline - Tokens.Space.tight)
                    .padding(.bottom, Tokens.Space.inset)
                if let record {
                    ForEach(record.days, id: \.date) { day in
                        JournalMonthRow(model: JournalMonthRowModel(day)) { router.showDay(day.date) }
                    }
                } else {
                    ProgressView()
                        .frame(maxWidth: .infinity)
                        .padding(.top, Tokens.Space.section)
                }
            }
            .padding(.horizontal, Tokens.Space.tight)
            .padding(.bottom, Tokens.Space.screenBlock)
        }
        .onScrollGeometryChange(for: Bool.self) { geometry in
            geometry.contentOffset.y + geometry.contentInsets.top > Tokens.Size.minimumHitArea
        } action: { _, collapsed in
            titleCollapsed = collapsed
        }
        .background(Tokens.Canvas.background.color)
        .navigationTitle(titleCollapsed ? JournalCopy.monthName(month) : "")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button(JournalCopy.previousMonth, systemImage: "chevron.backward") { step(-1) }
                    .accessibilityIdentifier("journal.month.previous")
                Button(JournalCopy.nextMonth, systemImage: "chevron.forward") { step(1) }
                    .accessibilityIdentifier("journal.month.next")
            }
        }
        .accessibilityIdentifier("journal.month")
        .task(id: reloadKey) { await store.loadMonth(year: year, month: month) }
    }

    private var record: JournalMonthRecord? {
        store.month(year: year, month: month)
    }

    private var subtitle: Text? {
        guard let record else { return nil }
        let parts = JournalMonthSubtitle(record)
        guard let streak = parts.streak else { return Text(parts.lead) }
        let tinted = Text(streak).foregroundStyle(Tokens.Text.tint.color)
        return Text("\(parts.lead)\(JournalCopy.subtitleSeparator)\(tinted)")
    }

    /// A write, a sync pass or midnight re-reads the month.
    private var reloadKey: String {
        "\(JournalStore.monthKey(year: year, month: month))|\(store.generation)|\(store.today)"
    }

    private func step(_ offset: Int) {
        let next = JournalMonthStep.shifted(year: year, month: month, by: offset)
        router.openMonth(year: next.year, month: next.month)
    }
}

/// The large serif title and its subtitle, drawn as a Month or Year screen's
/// first element (Paper J05, J06). The inline navigation title takes over
/// once it scrolls away.
struct JournalCalendarTitle: View {
    let title: String
    let subtitle: Text?

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.tight) {
            Text(title)
                .font(Tokens.Journal.title.font)
                .foregroundStyle(Tokens.Text.primary.color)
                .accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier("journal.calendar.title")
            if let subtitle {
                subtitle
                    .font(Tokens.Typography.supporting.font)
                    .foregroundStyle(Tokens.Text.tertiary.color)
                    .accessibilityIdentifier("journal.calendar.subtitle")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, Tokens.Space.medium)
    }
}
