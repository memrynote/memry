import MemryCore
import SwiftUI

// Spec 007 CL021. The calendar item chip (Paper 01/03, desktop
// `calendar-item-chip.tsx`): a rail and a quiet surface in the item's hue (or
// its own Google colour), the title in ink, the time in the hue's meta ink, a
// checkbox for tasks, a dashed outline for date reminders, faded once ended.

enum CalendarItemStyle {
    static func hue(_ item: CalendarItem) -> Tokens.Calendar.Hue {
        if let hex = item.displayColor, let custom = Tokens.Calendar.hue(hex: hex) { return custom }
        return Tokens.Calendar.hue(visualType: item.visualType)
    }

    /// `h:mm` (or `HH:mm`) in the user's locale.
    static func time(_ date: Date) -> String {
        date.formatted(.dateTime.hour().minute())
    }

    /// "10:00 – 11:30 · 1h 30m" / "9:00".
    static func timeRange(_ item: CalendarItem) -> String {
        guard !item.isAllDay else { return CalendarCopy.allDay }
        guard let end = item.endDate else { return time(item.startDate) }
        let minutes = Int(end.timeIntervalSince(item.startDate) / 60)
        return "\(time(item.startDate)) – \(time(end)) · \(CalendarCopy.duration(minutes: max(minutes, 0)))"
    }

    /// VoiceOver: "type, title, time, calendar" (goal Accessibility).
    static func accessibilityLabel(_ item: CalendarItem) -> String {
        [CalendarCopy.visualType(item.visualType), item.title, timeRange(item), item.source.title]
            .filter { !$0.isEmpty }
            .joined(separator: ", ")
    }
}

struct CalendarChip: View {
    /// `compact`: Week's narrow columns, the title only.
    enum Layout { case inline, block, compact }

    let item: CalendarItem
    var layout: Layout = .inline
    var now = Date()
    var isSelected = false
    /// Tasks: tapping the box completes in place.
    var onComplete: (() -> Void)?
    /// A span continued from yesterday / into tomorrow reads "Day 2 of 3".
    var spanLabel: String?
    /// A timed span continued from yesterday hides its start time.
    var showsTime = true
    @State private var width: CGFloat = .infinity

    var body: some View {
        let hue = CalendarItemStyle.hue(item)
        let ended = item.isEnded(now: now)
        content(hue)
            .padding(.leading, Tokens.Calendar.railWidth * 2 + Tokens.Space.tight)
            .padding(.trailing, layout == .compact ? 2 : Tokens.Space.small)
            .padding(.vertical, layout == .inline ? 0 : Tokens.Space.tight)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: layout == .inline ? .leading : .topLeading)
            .background {
                RoundedRectangle(cornerRadius: Tokens.Calendar.chipRadius)
                    .fill(isSelected ? hue.rail.color : hue.surface.color)
            }
            .overlay(alignment: .leading) {
                if item.visualType != "note_date" {
                    RoundedRectangle(cornerRadius: 2)
                        .fill(isSelected ? Tokens.Tint.foreground.color : hue.rail.color)
                        .frame(width: Tokens.Calendar.railWidth)
                        .padding(.vertical, Tokens.Calendar.railWidth)
                        .padding(.leading, Tokens.Calendar.railWidth)
                }
            }
            .overlay {
                if item.visualType == "note_date" {
                    RoundedRectangle(cornerRadius: Tokens.Calendar.chipRadius)
                        .strokeBorder(hue.rail.color.opacity(0.5), style: StrokeStyle(lineWidth: 1, dash: [3, 2]))
                }
            }
            .opacity(ended && !isSelected ? Tokens.Calendar.endedOpacity : 1)
            .contentShape(.rect(cornerRadius: Tokens.Calendar.chipRadius))
    }

    @ViewBuilder
    private func content(_ hue: Tokens.Calendar.Hue) -> some View {
        let ink = isSelected ? Tokens.Tint.foreground.color : Tokens.Text.primary.color
        let meta = isSelected ? Tokens.Tint.foreground.color : hue.meta.color
        switch layout {
        case .inline:
            HStack(spacing: Tokens.Space.tight + 2) {
                checkbox(hue)
                Text(title)
                    .font(Tokens.Calendar.chipTitle.font)
                    .foregroundStyle(ink)
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if !item.isAllDay, showsTime {
                    // The time drops first when the chip is too narrow.
                    ViewThatFits {
                        Text(CalendarItemStyle.time(item.startDate))
                            .font(Tokens.Calendar.chipMeta.font)
                            .foregroundStyle(meta)
                            .lineLimit(1)
                            .fixedSize()
                        EmptyView()
                    }
                }
            }
        case .compact:
            // Below ~3 letters a column breaks words letter by letter; the
            // rail and hue carry the item there (VoiceOver keeps the title).
            Text(title)
                .font(Tokens.Calendar.chipTitle.font)
                .foregroundStyle(ink)
                .lineLimit(4)
                .truncationMode(.tail)
                .opacity(width >= Tokens.Calendar.compactTitleMinWidth ? 1 : 0)
                .frame(maxWidth: .infinity, alignment: .leading)
                .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
        case .block:
            VStack(alignment: .leading, spacing: 1) {
                HStack(alignment: .top, spacing: Tokens.Space.tight + 2) {
                    checkbox(hue)
                    Text(title)
                        .font(Tokens.Calendar.chipTitle.font)
                        .foregroundStyle(ink)
                        .multilineTextAlignment(.leading)
                }
                Text(CalendarItemStyle.timeRange(item))
                    .font(Tokens.Calendar.chipMeta.font)
                    .foregroundStyle(meta)
                    .lineLimit(1)
            }
        }
    }

    private var title: String {
        guard let spanLabel else { return item.title }
        return "\(item.title) · \(spanLabel)"
    }

    @ViewBuilder
    private func checkbox(_ hue: Tokens.Calendar.Hue) -> some View {
        if item.visualType == "task", onComplete != nil {
            Button {
                onComplete?()
            } label: {
                RoundedRectangle(cornerRadius: 4)
                    .strokeBorder(hue.rail.color, lineWidth: 1.5)
                    .frame(width: 12, height: 12)
                    .frame(width: Tokens.Size.minimumHitArea / 2, height: Tokens.Size.minimumHitArea / 2)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(CalendarCopy.completeTask(item.title))
        }
    }
}

/// The item's long-press menu when there is one (a plain `.contextMenu` with
/// no items would still lift the chip).
private struct CalendarItemMenu: ViewModifier {
    let menu: ((CalendarItem) -> AnyView)?
    let item: CalendarItem

    func body(content: Content) -> some View {
        if let menu {
            content.contextMenu { menu(item) }
        } else {
            content
        }
    }
}

extension View {
    func calendarItemMenu(_ menu: ((CalendarItem) -> AnyView)?, item: CalendarItem) -> some View {
        modifier(CalendarItemMenu(menu: menu, item: item))
    }
}

/// A sheet's close button: an ink glyph on the glass (00 rule 6).
struct CalendarCloseButton: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "xmark").foregroundStyle(Tokens.Text.primary.color)
        }
        .accessibilityLabel(CalendarCopy.close)
    }
}
