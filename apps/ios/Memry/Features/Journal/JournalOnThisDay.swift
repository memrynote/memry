import MemryCore
import SwiftUI

// #4351 (D8). "On this day" in the Journal rail (desktop
// `journal-past-years.tsx`, previews layout): the shown day in other years,
// newest first, each row its year, how far away it is and the entry's
// preview. A tap shows that day. Hidden when no other year has an entry.

struct JournalOnThisDay: View {
    let store: JournalStore
    let date: String
    let show: (String) -> Void

    @State private var entries: [JournalSameDayEntry] = []
    @State private var failed = false

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.small) {
            if failed {
                header
                Text(JournalCopy.Rail.sameDayLoadError)
                    .font(Tokens.Typography.supporting.font)
                    .foregroundStyle(Tokens.Text.secondary.color)
            } else if !entries.isEmpty {
                header
                ForEach(entries) { entry in
                    row(entry)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityIdentifier("journal.rail.onThisDay")
        // Only the shown day is edited here, so other years change only
        // through a sync pass.
        .task(id: "\(date)|\(store.syncPasses)") {
            let read = await store.sameDayEntries(date)
            guard !Task.isCancelled else { return }
            failed = read == nil
            entries = read ?? []
        }
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: Tokens.Space.small) {
            Text(JournalCopy.Rail.onThisDay)
                .font(Tokens.Typography.label.font.weight(.semibold))
                .foregroundStyle(Tokens.Text.primary.color)
            if !entries.isEmpty {
                Text(JournalCopy.Rail.otherYears(entries.count))
                    .font(Tokens.Typography.caption.font)
                    .foregroundStyle(Tokens.Text.tertiary.color)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }

    private func row(_ entry: JournalSameDayEntry) -> some View {
        Button { show(entry.date) } label: {
            HStack(alignment: .firstTextBaseline, spacing: Tokens.Space.small) {
                JournalActivityDot(level: entry.level)
                VStack(alignment: .leading, spacing: Tokens.Space.tight / 2) {
                    HStack(alignment: .firstTextBaseline, spacing: Tokens.Space.small) {
                        Text(verbatim: String(entry.date.prefix(4)))
                            .font(Tokens.Typography.supporting.font.weight(.semibold).monospacedDigit())
                            .foregroundStyle(Tokens.Text.primary.color)
                        Text(JournalCopy.Rail.sameDayDistance(entry.date, shown: date, today: store.today))
                            .font(Tokens.Typography.caption.font)
                            .foregroundStyle(Tokens.Text.tertiary.color)
                    }
                    if !entry.preview.isEmpty {
                        Text(entry.preview)
                            .font(Tokens.Typography.supporting.font)
                            .foregroundStyle(Tokens.Text.secondary.color)
                            .lineLimit(3)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.vertical, Tokens.Space.tight)
            .frame(minHeight: Tokens.Size.minimumHitArea)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityHint(JournalCopy.openDayHint)
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier("journal.rail.year.\(entry.date)")
    }
}
