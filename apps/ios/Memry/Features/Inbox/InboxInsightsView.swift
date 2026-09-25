import MemryCore
import SwiftUI

// IB20. Insights (Paper 20, desktop `inbox-health-view.tsx`), one column:
// four stats (Captured, Processed + rate, Stale, Avg time to file), the
// capture heatmap by weekday and two-hour slot with its peak, By type, and
// Recent filings. Every number is the core's (`Inbox.stats`, `patterns`).

struct InboxInsightsView<Header: View>: View {
    let store: InboxStore
    @Binding var titleCollapsed: Bool
    @ViewBuilder let header: () -> Header

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Tokens.Space.section) {
                header()
                if let stats = store.stats {
                    Grid(horizontalSpacing: Tokens.Space.medium, verticalSpacing: Tokens.Space.medium) {
                        GridRow {
                            card(InboxCopy.captured, "\(stats.totalItems)", InboxCopy.capturedThisWeek(Int(stats.capturedThisWeek)), .complete)
                            card(InboxCopy.processed, "\(stats.processedThisWeek)", InboxCopy.processRate(Int(stats.processRate)), nil)
                        }
                        GridRow {
                            card(InboxCopy.stale, "\(stats.staleCount)",
                                 stats.staleCount > 0 ? InboxCopy.needsAttention : InboxCopy.allClear,
                                 stats.staleCount > 0 ? .attention : .complete)
                            card(InboxCopy.avgTimeToFile, InboxInsightsFormat.avgTime(Int(stats.avgTimeToProcessMinutes)), "", nil)
                        }
                    }
                }
                InboxHeatmap(pattern: store.patterns)
                byType
                filings
            }
            .padding(.horizontal, InboxLayout.edge)
            .padding(.bottom, Tokens.Space.screenBlock)
        }
        .background(Tokens.Canvas.background.color)
        .refreshable { await store.sync() }
        .onScrollGeometryChange(for: Bool.self) { $0.contentOffset.y + $0.contentInsets.top > Tokens.Size.minimumHitArea }
            action: { _, collapsed in titleCollapsed = collapsed }
        .accessibilityIdentifier("inbox.insights")
    }

    private enum Tone { case complete, attention }

    private func card(_ label: String, _ value: String, _ sub: String, _ tone: Tone?) -> some View {
        VStack(alignment: .leading, spacing: Tokens.Space.tight) {
            Text(label).font(Tokens.Typography.caption.font).foregroundStyle(Tokens.Text.tertiary.color)
            Text(value).font(Tokens.Typography.screenTitle.font.weight(.semibold).monospacedDigit())
                .foregroundStyle(Tokens.Text.primary.color)
            if !sub.isEmpty {
                Text(sub).font(Tokens.Typography.caption.font)
                    .foregroundStyle(tone == .attention ? Tokens.Interaction.destructive.color
                        : tone == .complete ? Tokens.Task.complete.color : Tokens.Text.tertiary.color)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(Tokens.Space.inset)
        .background(Tokens.Canvas.surface.color, in: .rect(cornerRadius: Tokens.Radius.card))
        .accessibilityElement(children: .combine)
    }

    private var byType: some View {
        let types = (store.patterns?.types ?? []).filter { $0.count >= 1 }
        let top = types.first?.count ?? 0
        return VStack(alignment: .leading, spacing: Tokens.Space.small) {
            Text(InboxCopy.byType).font(Tokens.Typography.caption.font.weight(.semibold))
                .foregroundStyle(Tokens.Text.secondary.color)
            if types.isEmpty {
                Text(InboxCopy.noItemsYet).font(Tokens.Typography.supporting.font).foregroundStyle(Tokens.Text.tertiary.color)
            }
            ForEach(types, id: \.itemType) { share in
                HStack(spacing: Tokens.Space.medium) {
                    Text(InboxCopy.typePlural(share.itemType)).font(Tokens.Typography.caption.font)
                        .frame(width: 72, alignment: .leading)
                    GeometryReader { geometry in
                        Capsule().fill(Tokens.Inbox.type(share.itemType).color)
                            .frame(width: max(4, geometry.size.width * CGFloat(share.count) / CGFloat(max(top, 1))))
                    }
                    .frame(height: Tokens.Space.small)
                    Text("\(share.count)").font(Tokens.Typography.caption.font.monospacedDigit())
                        .foregroundStyle(Tokens.Text.tertiary.color)
                }
                .accessibilityElement(children: .combine)
            }
        }
    }

    private var filings: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.small) {
            Text(InboxCopy.recentFilings).font(Tokens.Typography.caption.font.weight(.semibold))
                .foregroundStyle(Tokens.Text.secondary.color)
            if store.history.isEmpty {
                Text(InboxCopy.noItemsFiled).font(Tokens.Typography.supporting.font).foregroundStyle(Tokens.Text.tertiary.color)
            }
            ForEach(store.history, id: \.id) { item in
                HStack(spacing: Tokens.Space.medium) {
                    InboxTypeIcon(type: item.itemType)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(InboxMeta.displayTitle(item)).font(Tokens.Typography.body.font).lineLimit(1)
                        let filedAt = Date(timeIntervalSince1970: TimeInterval(item.filedAtMs ?? 0) / 1000)
                        let age = InboxMeta.age(filedAt, now: store.clock())
                        Text("\(InboxInsightsFormat.destination(item)) · \(age)")
                            .font(Tokens.Typography.caption.font).foregroundStyle(Tokens.Text.tertiary.color)
                    }
                }
                .accessibilityElement(children: .combine)
            }
        }
    }
}

enum InboxInsightsFormat {
    /// `formatAvgTime`: —, 45m, 3.5h, 1.4d.
    static func avgTime(_ minutes: Int) -> String {
        if minutes <= 0 { return "—" }
        if minutes < 60 { return "\(minutes)m" }
        if minutes < 1440 { return String(format: "%.1fh", Double(minutes) / 60) }
        return String(format: "%.1fd", Double(minutes) / 1440)
    }

    /// Where a filing went: the folder, or what it became.
    static func destination(_ item: InboxItemRecord) -> String {
        switch item.filedAction {
        case "task": InboxCopy.convertedToTask
        case "reminder": InboxCopy.convertedTo(InboxCopy.convertReminder)
        case "event": InboxCopy.convertedTo(InboxCopy.convertEvent)
        default:
            InboxFolderName.display((item.filedTo ?? "").split(separator: "/").dropLast().joined(separator: "/"))
        }
    }
}

/// Weekdays down, two-hour slots across (desktop's 06-22 hours), cell
/// intensity from the busiest slot; the peak underneath.
struct InboxHeatmap: View {
    let pattern: InboxPatternRecord?
    private let hours = [6, 8, 10, 12, 14, 16, 18, 20, 22]
    private let days = ["M", "T", "W", "T", "F", "S", "S"]

    var body: some View {
        let grid = pattern?.heatmap ?? []
        let value = { (day: Int, hour: Int) -> Int64 in
            guard hour < grid.count, day < 7 else { return 0 }
            return grid[hour][day] + (hour + 1 < grid.count ? grid[hour + 1][day] : 0)
        }
        let top = days.indices.flatMap { day in hours.map { value(day, $0) } }.max() ?? 0
        return VStack(alignment: .leading, spacing: Tokens.Space.small) {
            Text(InboxCopy.captureActivity).font(Tokens.Typography.caption.font.weight(.semibold))
                .foregroundStyle(Tokens.Text.secondary.color)
            ForEach(days.indices, id: \.self) { day in
                HStack(spacing: 3) {
                    Text(days[day]).font(Tokens.Typography.caption.font).frame(width: 16)
                        .foregroundStyle(Tokens.Text.tertiary.color)
                    ForEach(hours, id: \.self) { hour in
                        RoundedRectangle(cornerRadius: 2)
                            .fill(Tokens.Tint.base.color.opacity(top > 0 ? 0.08 + 0.82 * Double(value(day, hour)) / Double(top) : 0.08))
                            .frame(height: 14)
                    }
                }
            }
            .accessibilityHidden(true)
            Text(peakText).font(Tokens.Typography.caption.font).foregroundStyle(Tokens.Text.tertiary.color)
        }
        .accessibilityElement(children: .combine)
    }

    private var peakText: String {
        guard let day = pattern?.peakDay, let hour = pattern?.peakHour else { return InboxCopy.noCapturesYet }
        let names = Calendar(identifier: .gregorian).weekdaySymbols
        let name = names[(Int(day) + 1) % 7]
        return InboxCopy.peak(name, String(format: "%02d:00", Int(hour)), String(format: "%02d:00", min(Int(hour) + 2, 24)))
    }
}
