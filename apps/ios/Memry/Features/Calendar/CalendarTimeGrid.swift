import MemryCore
import SwiftUI

// Spec 007 CL021/CL030/CL031. The hour grid Day and Week share: a time gutter,
// hairlines on the white canvas, timed chips laid out in overlap lanes per
// column, the tint now line on today, and the gestures of artboards 12 and 16
// (long press + drag on empty time creates, hold + drag on a chip moves).

struct CalendarGridActions {
    var open: (CalendarItem) -> Void = { _ in }
    var complete: (CalendarItem) -> Void = { _ in }
    /// The long-press menu (artboard 15). Movable chips cannot also carry the
    /// system context menu (it takes the same long press), so for them a
    /// hold released without moving asks the screen to show it (§6 CL044).
    var contextMenu: ((CalendarItem) -> AnyView)?
    var menu: ((CalendarItem) -> Void)?
    /// A selection made on empty time: day key, start and end minutes.
    var select: ((String, Int, Int) -> Void)?
    /// A range of whole days (Month's long press + drag): first and last day.
    var selectDays: ((String, String) -> Void)?
    /// A chip dropped at a new start (minutes on a day), or resized.
    var move: ((CalendarItem, String, Int, Int?) -> Void)?
    /// The range the open composer is creating (Paper 12 keeps it drawn).
    var pending: CalendarGridSelection?
}

struct CalendarTimeGrid: View {
    let days: [String]
    let items: [CalendarItem]
    let today: String
    let now: Date
    var actions = CalendarGridActions()
    var selection: CalendarGridSelection?
    @Binding var dragState: CalendarDragState?

    @ScaledMetric(relativeTo: .caption2) private var hourHeight = Tokens.Calendar.hourHeight
    @Environment(\.layoutDirection) private var direction

    var body: some View {
        GeometryReader { proxy in
            let columnWidth = max((proxy.size.width - Tokens.Calendar.gutterWidth - Tokens.Space.medium) / CGFloat(days.count), 1)
            ZStack(alignment: .topLeading) {
                hourLines
                ForEach(Array(days.enumerated()), id: \.element) { index, day in
                    column(day: day, width: columnWidth)
                        .frame(width: columnWidth, height: hourHeight * 24)
                        .offset(x: Tokens.Calendar.gutterWidth + CGFloat(index) * columnWidth)
                }
                if let selection = selection ?? actions.pending, let index = days.firstIndex(of: selection.day) {
                    CalendarSelectionBlock(selection: selection, hourHeight: hourHeight)
                        .frame(width: columnWidth - 2)
                        .offset(x: Tokens.Calendar.gutterWidth + CGFloat(index) * columnWidth + 1,
                                y: CGFloat(selection.startMinute) / 60 * hourHeight)
                }
                if let index = days.firstIndex(of: today) {
                    nowLine(width: days.count == 1 ? proxy.size.width - Tokens.Calendar.gutterWidth - Tokens.Space.medium : columnWidth)
                        .offset(x: Tokens.Calendar.gutterWidth + CGFloat(index) * columnWidth - Tokens.Calendar.nowDot / 2,
                                y: CGFloat(CalendarDates.minutes(now)) / 60 * hourHeight - Tokens.Calendar.nowDot / 2)
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)
                }
            }
            .frame(width: proxy.size.width, height: hourHeight * 24, alignment: .topLeading)
            .coordinateSpace(.named(CalendarGridSpace.name))
        }
        .frame(height: hourHeight * 24)
    }

    private var hourLines: some View {
        VStack(spacing: 0) {
            ForEach(0 ..< 24, id: \.self) { hour in
                HStack(alignment: .top, spacing: 0) {
                    Text(hour == 0 ? "" : Self.hourLabel(hour))
                        .font(Tokens.Calendar.gutter.font)
                        .foregroundStyle(Tokens.Text.tertiary.color)
                        .frame(width: Tokens.Calendar.gutterWidth - Tokens.Space.small, alignment: .trailing)
                        .padding(.trailing, Tokens.Space.small)
                        .offset(y: -7)
                    Rectangle()
                        .fill(Tokens.Line.border.color)
                        .frame(height: 0.5)
                        .padding(.trailing, Tokens.Space.medium)
                }
                .frame(height: hourHeight, alignment: .top)
                .id(CalendarGridSpace.hourID(hour))
                .accessibilityHidden(true)
            }
        }
    }

    static func hourLabel(_ hour: Int) -> String {
        if hour == 12, !Self.uses24Hour { return CalendarCopy.noon }
        let date = Calendar.current.date(bySettingHour: hour, minute: 0, second: 0, of: Date()) ?? Date()
        return date.formatted(.dateTime.hour())
    }

    static var uses24Hour: Bool {
        let format = DateFormatter.dateFormat(fromTemplate: "j", options: 0, locale: .current) ?? ""
        return !format.contains("a")
    }

    private func column(day: String, width: CGFloat) -> some View {
        let timed = items.filter { !$0.isSpanning && CalendarDates.key($0.startDate) == day }
        let lanes = CalendarLayout.lanes(timed, start: \.startDate, end: \.endDate)
        return ZStack(alignment: .topLeading) {
            CalendarEmptyTime(day: day, hourHeight: hourHeight, onSelect: actions.select, dragState: $dragState)
            ForEach(lanes, id: \.item.projectionId) { lane in
                chip(lane, width: width)
            }
        }
    }

    private func chip(_ lane: CalendarLayout.Lane<CalendarItem>, width: CGFloat) -> some View {
        let item = lane.item
        let startMinutes = CalendarDates.minutes(item.startDate)
        let duration = item.endDate.map { max($0.timeIntervalSince(item.startDate) / 60, 15) } ?? 30
        let height = max(CGFloat(duration) / 60 * hourHeight - 1, 24)
        let laneWidth = (width - 2) / CGFloat(lane.laneCount)
        return CalendarGridChip(
            item: item,
            now: now,
            layout: days.count > 1 ? .compact : (height >= 44 ? .block : .inline),
            hourHeight: hourHeight,
            actions: actions,
            dragState: $dragState
        )
        .frame(width: max(laneWidth - 2, 8), height: height)
        .offset(x: 1 + CGFloat(lane.lane) * laneWidth, y: CGFloat(startMinutes) / 60 * hourHeight)
    }

    private func nowLine(width: CGFloat) -> some View {
        HStack(spacing: 0) {
            Circle().fill(Tokens.Tint.base.color).frame(width: Tokens.Calendar.nowDot, height: Tokens.Calendar.nowDot)
            Rectangle().fill(Tokens.Tint.base.color).frame(width: width, height: Tokens.Calendar.nowLineWidth)
        }
    }
}

enum CalendarGridSpace {
    static let name = "calendar.grid"
    static func hourID(_ hour: Int) -> String { "calendar.hour.\(hour)" }
    /// 15-minute snap (artboards 12, 16).
    static func snap(_ minutes: Int) -> Int { max(0, min(24 * 60 - 15, Int((Double(minutes) / 15).rounded()) * 15)) }
}
