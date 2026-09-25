import MemryCore
import SwiftUI

// JP044. The Year screen, the root of the Journal stack (Paper J06, desktop
// `journal-year-view.tsx`): twelve month cards in three columns, the year's
// totals (days with entries, characters written), the streak and the best
// streak under the title, ‹ › for the neighbouring years, and a tap that
// opens the month. Reads only (D2).

struct JournalYearScreen: View {
    let store: JournalStore

    @Environment(JournalRouter.self) private var router
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var titleCollapsed = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                JournalCalendarTitle(title: title, subtitle: subtitle)
                    .padding(.bottom, Tokens.Space.inset)
                if let record {
                    LazyVGrid(columns: columns, spacing: Tokens.Space.small) {
                        ForEach(cards(record)) { card in
                            JournalYearCard(model: card) { router.openMonth(year: year, month: card.month) }
                        }
                    }
                    totals(record)
                        .padding(.top, Tokens.Space.section)
                } else {
                    JournalLoadState(store: store) { await store.loadYear(year) }
                }
            }
            .padding(.horizontal, Tokens.Space.screenInline)
            .padding(.bottom, Tokens.Space.screenBlock)
        }
        .onScrollGeometryChange(for: Bool.self) { geometry in
            geometry.contentOffset.y + geometry.contentInsets.top > Tokens.Size.minimumHitArea
        } action: { _, collapsed in
            titleCollapsed = collapsed
        }
        .background(Tokens.Canvas.background.color)
        .navigationTitle(titleCollapsed ? title : "")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button(JournalCopy.previousYear, systemImage: "chevron.backward") { router.rootYear = year - 1 }
                    .accessibilityIdentifier("journal.year.previous")
                Button(JournalCopy.nextYear, systemImage: "chevron.forward") { router.rootYear = year + 1 }
                    .accessibilityIdentifier("journal.year.next")
            }
        }
        .accessibilityIdentifier("journal.year")
        .task(id: reloadKey) { await store.loadYear(year) }
    }

    private var year: Int { router.rootYear }

    /// "2026", without a grouping separator.
    private var title: String { String(year) }

    private var record: JournalYearRecord? {
        store.years[Int64(year)]
    }

    /// Three columns (Paper J06); two at accessibility sizes so names and
    /// counts keep their room (JP057).
    private var columns: [GridItem] {
        let count = dynamicTypeSize.isAccessibilitySize ? 2 : 3
        return Array(repeating: GridItem(.flexible(), spacing: Tokens.Space.small), count: count)
    }

    private func cards(_ record: JournalYearRecord) -> [JournalYearCardModel] {
        record.months.map { JournalYearCardModel($0, year: year, today: store.today) }
    }

    private var subtitle: Text? {
        guard let record else { return nil }
        let parts = JournalYearSubtitle(record)
        let separator = JournalCopy.subtitleSeparator
        var text = Text(parts.lead)
        if let streak = parts.streak {
            let tinted = Text(streak).foregroundStyle(Tokens.Text.tint.color)
            text = Text("\(text)\(separator)\(tinted)")
        }
        if let best = parts.best {
            text = Text("\(text)\(separator)\(best)")
        }
        return text
    }

    private func totals(_ record: JournalYearRecord) -> some View {
        HStack(alignment: .top, spacing: Tokens.Space.inset) {
            total(value: "\(record.daysWithEntries)", label: JournalCopy.daysWithEntries, id: "days")
            total(value: JournalCopy.thousands(record.totalCharacters), label: JournalCopy.charactersWritten, id: "characters")
        }
    }

    private func total(value: String, label: String, id: String) -> some View {
        VStack(alignment: .leading, spacing: Tokens.Space.tight / 2) {
            Divider()
                .padding(.bottom, Tokens.Space.medium)
            Text(value)
                .font(Tokens.Typography.editorial.font)
                .foregroundStyle(Tokens.Text.primary.color)
            Text(label)
                .font(Tokens.Typography.caption.font)
                .foregroundStyle(Tokens.Text.tertiary.color)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("journal.year.total.\(id)")
    }

    /// A write, a sync pass or midnight re-reads the year.
    private var reloadKey: String {
        "\(year)|\(store.generation)|\(store.today)"
    }
}
