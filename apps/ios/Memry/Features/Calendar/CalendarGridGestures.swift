import MemryCore
import SwiftUI

// Spec 007 CL040/CL044 (artboards 12, 16). The grid's two gestures:
// - long press + drag on empty time selects a range, 15-minute snap, a
//   selection haptic per snap (desktop `use-time-grid-marquee.ts`);
// - hold + drag on a movable chip moves it, the edges resize it, with a snap
//   label and the origin left faded (desktop `use-event-drag.ts`).
// A plain tap on a chip opens it; a long press without movement opens the
// context menu (00 rule 1).

/// A range being drawn on empty time.
struct CalendarGridSelection: Equatable {
    var day: String
    var startMinute: Int
    var endMinute: Int
}

/// A chip being moved or resized.
struct CalendarDragState: Equatable {
    enum Edge { case move, top, bottom }
    let projectionId: String
    var edge: Edge
    var deltaMinutes: Int

    /// Empty time being selected: no item moves, but the grid must hold still.
    static let selecting = CalendarDragState(projectionId: "", edge: .move, deltaMinutes: 0)
}

/// Empty time: a long press starts a selection, dragging extends it.
struct CalendarEmptyTime: View {
    let day: String
    let hourHeight: CGFloat
    let onSelect: ((String, Int, Int) -> Void)?
    @Binding var dragState: CalendarDragState?
    @State private var anchor: Int?
    @State private var current: Int?

    var body: some View {
        Color.clear
            .contentShape(.rect)
            // A pan that starts here still scrolls and pages; once the hold
            // lands the grid stops (`dragState`).
            .gesture(selectGesture)
            .overlay(alignment: .topLeading) {
                if let range {
                    CalendarSelectionBlock(
                        selection: CalendarGridSelection(day: day, startMinute: range.lowerBound, endMinute: range.upperBound),
                        hourHeight: hourHeight
                    )
                    .offset(y: CGFloat(range.lowerBound) / 60 * hourHeight)
                }
            }
            .sensoryFeedback(.selection, trigger: current)
            .accessibilityElement()
            .accessibilityLabel(day)
            .accessibilityActions {
                if let onSelect {
                    ForEach([9, 12, 15], id: \.self) { hour in
                        Button(CalendarCopy.newEventAt(CalendarTimeGrid.hourLabel(hour))) {
                            onSelect(day, hour * 60, hour * 60 + 60)
                        }
                    }
                }
            }
    }

    private var range: ClosedRange<Int>? {
        guard let anchor, let current else { return nil }
        let low = min(anchor, current), high = max(anchor, current) + 15
        return low ... max(high, low + 15)
    }

    private func minutes(_ y: CGFloat) -> Int {
        let raw = Int(y / hourHeight * 60)
        return max(0, min(24 * 60 - 15, (raw / 15) * 15))
    }

    private var selectGesture: CalendarHoldDrag {
        CalendarHoldDrag(minimumDuration: 0.35, isEnabled: onSelect != nil) { phase in
            switch phase {
            case let .began(location):
                dragState = .selecting
                anchor = minutes(location.y)
                current = anchor
            case let .changed(_, location):
                current = minutes(location.y)
            case let .ended(_, _, completed):
                defer { anchor = nil; current = nil; dragState = nil }
                guard completed, let range else { return }
                // A plain long press (no drag) selects an hour, as desktop's
                // click-and-release on the grid does.
                let end = range.upperBound - range.lowerBound <= 15 ? range.lowerBound + 60 : range.upperBound
                onSelect?(day, range.lowerBound, end)
            }
        }
    }
}

/// The dashed-tint selection with its time label (artboard 12).
struct CalendarSelectionBlock: View {
    let selection: CalendarGridSelection
    let hourHeight: CGFloat

    var body: some View {
        let height = CGFloat(selection.endMinute - selection.startMinute) / 60 * hourHeight
        RoundedRectangle(cornerRadius: Tokens.Calendar.chipRadius)
            .fill(Tokens.Tint.base.color.opacity(0.16))
            .overlay {
                RoundedRectangle(cornerRadius: Tokens.Calendar.chipRadius)
                    .strokeBorder(Tokens.Tint.base.color, lineWidth: 1.5)
            }
            .overlay(alignment: .topLeading) {
                Text(label)
                    .font(Tokens.Calendar.chipTitle.font)
                    .foregroundStyle(Tokens.Text.tint.color)
                    .padding(Tokens.Space.tight)
            }
            .frame(height: max(height, 14))
            .allowsHitTesting(false)
    }

    private var label: String {
        "\(Self.clock(selection.startMinute)) – \(Self.clock(selection.endMinute))"
    }

    static func clock(_ minutes: Int) -> String {
        let date = Calendar.current.date(bySettingHour: min(minutes / 60, 23), minute: minutes % 60, second: 0, of: Date()) ?? Date()
        return CalendarItemStyle.time(minutes >= 24 * 60 ? date.addingTimeInterval(60) : date)
    }
}

/// A chip on the grid: tap opens, long press opens the menu, hold + drag moves.
struct CalendarGridChip: View {
    let item: CalendarItem
    let now: Date
    let layout: CalendarChip.Layout
    let hourHeight: CGFloat
    let actions: CalendarGridActions
    @Binding var dragState: CalendarDragState?
    @State private var liveDelta = 0

    var body: some View {
        let dragging = dragState?.projectionId == item.projectionId
        CalendarChip(
            item: item, layout: layout, now: now, isSelected: dragging,
            onComplete: item.visualType == "task" ? { actions.complete(item) } : nil
        )
        .offset(y: dragging && dragState?.edge == .move ? CGFloat(liveDelta) / 60 * hourHeight : 0)
        .overlay(alignment: .topTrailing) {
            if dragging {
                Text(CalendarSelectionBlock.clock(CalendarDates.minutes(item.startDate) + liveDelta))
                    .font(Tokens.Calendar.chipMeta.font.weight(.semibold))
                    .foregroundStyle(Tokens.Tint.foreground.color)
                    .padding(.horizontal, Tokens.Space.tight)
                    .background(Tokens.Tint.base.color, in: .capsule)
                    .offset(y: CGFloat(liveDelta) / 60 * hourHeight - 18)
            }
        }
        .background {
            if dragging {
                CalendarChip(item: item, layout: layout, now: now).opacity(0.35)
            }
        }
        .onTapGesture { actions.open(item) }
        .gesture(moveGesture)
        .sensoryFeedback(.selection, trigger: liveDelta)
        .calendarItemMenu(item.canDrag && actions.move != nil ? nil : actions.contextMenu, item: item)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(CalendarItemStyle.accessibilityLabel(item))
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { actions.open(item) }
        .accessibilityActions {
            if item.visualType == "task" {
                Button(CalendarCopy.completeTask(item.title)) { actions.complete(item) }
            }
            if item.canDrag, let move = actions.move {
                let day = CalendarDates.key(item.startDate)
                let start = CalendarDates.minutes(item.startDate)
                Button(CalendarCopy.moveEarlier) { move(item, day, start - 15, nil) }
                Button(CalendarCopy.moveLater) { move(item, day, start + 15, nil) }
            }
        }
    }

    private var moveGesture: CalendarHoldDrag {
        CalendarHoldDrag(
            minimumDuration: 0.3, space: .named(CalendarGridSpace.name),
            isEnabled: item.canDrag && actions.move != nil
        ) { phase in
            switch phase {
            case .began:
                dragState = CalendarDragState(projectionId: item.projectionId, edge: .move, deltaMinutes: 0)
            case let .changed(start, location):
                let raw = Int((location.y - start.y) / hourHeight * 60)
                liveDelta = Int((Double(raw) / 15).rounded()) * 15
            case let .ended(_, _, completed):
                let delta = liveDelta
                liveDelta = 0
                dragState = nil
                guard completed else { return }
                guard delta != 0 else {
                    // Held, not moved: the item's menu.
                    actions.menu?(item)
                    return
                }
                let day = CalendarDates.key(item.startDate)
                actions.move?(item, day, CalendarDates.minutes(item.startDate) + delta, nil)
            }
        }
    }
}
