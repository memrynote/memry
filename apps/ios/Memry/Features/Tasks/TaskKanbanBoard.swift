import MemryCore
import SwiftUI

// TP049, redesigned (RD16, Paper "Board (paged columns)"). The kanban board
// (desktop `components/tasks/kanban/kanban-board.tsx`).
//
// **Paged columns.** One column at a time, paging horizontally
// (`viewAligned`), the next one peeking in at the trailing edge; page dots
// below say where you are and page on tap. The title header scrolls away
// with the board as it does on the list. The column mode is the "…" menu's
// "Columns" (RD12).
//
// **Moving a card.** Drag it onto the column peeking at the edge; any column,
// near or far, is in the card's long-press "Move to" menu and in its VoiceOver
// actions (a drag across a paged scroll view does not page it).

struct TaskKanbanBoard<Header: View>: View {
    let store: TasksStore
    @Binding var titleCollapsed: Bool
    @ViewBuilder let header: () -> Header

    @State private var dueBuckets: [String: String] = [:]
    @State private var visibleColumn: String?

    /// How much of the next column shows at the trailing edge.
    private static var peek: CGFloat { Tokens.Size.minimumHitArea + Tokens.Space.section }

    var body: some View {
        let lanes = store.kanbanLanes(dueBuckets: dueBuckets)
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: Tokens.Space.medium) {
                header()
                    .padding(.horizontal, TaskLayout.edge)
                ScrollView(.horizontal) {
                    // Not lazy: the row takes the tallest column's height, so a long
                    // column off screen is not clipped when paged to.
                    HStack(alignment: .top, spacing: Tokens.Space.medium) {
                        ForEach(lanes) { lane in
                            KanbanColumnView(
                                store: store,
                                lane: lane,
                                allColumns: lanes.map(\.column),
                                onDrop: drop
                            )
                            .containerRelativeFrame(.horizontal) { length, _ in
                                max(length - Self.peek - Tokens.Space.medium, Tokens.Size.minimumHitArea)
                            }
                            .id(lane.id)
                        }
                    }
                    .scrollTargetLayout()
                }
                .scrollTargetBehavior(.viewAligned)
                .scrollPosition(id: $visibleColumn, anchor: .leading)
                .contentMargins(.horizontal, Tokens.Space.inset, for: .scrollContent)
                .scrollIndicators(.hidden)
                KanbanPageDots(lanes: lanes, visibleColumn: $visibleColumn)
            }
            .padding(.bottom, Tokens.Space.screenBlock)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(Tokens.Canvas.background.color)
        .onScrollGeometryChange(for: Bool.self) { geometry in
            geometry.contentOffset.y + geometry.contentInsets.top > Tokens.Size.minimumHitArea
        } action: { _, collapsed in
            titleCollapsed = collapsed
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(TasksCopy.kanbanBoard)
        .accessibilityIdentifier("tasks.kanban.board")
        .task(id: BucketKey(result: store.result, mode: store.kanbanEffectiveMode)) {
            dueBuckets = store.kanbanEffectiveMode == .dueDate ? await store.kanbanLoadDueBuckets() : [:]
        }
        // A new column set starts at its first column (dots and scroll agree).
        .onChange(of: store.kanbanEffectiveMode) { _, _ in
            visibleColumn = store.kanbanLanes(dueBuckets: dueBuckets).first?.id
        }
    }

    /// A task id dropped on a column.
    private func drop(_ taskId: String, on column: KanbanColumn) {
        let buckets = dueBuckets
        Task { await store.kanbanMove(taskId: taskId, to: column, dueBuckets: buckets) }
    }

    /// Reloads the due buckets whenever the page answer or the mode changes.
    private struct BucketKey: Equatable {
        let result: TaskViewResult?
        let mode: KanbanColumnMode
    }
}

/// One dot per column, the visible one in ink; a tap pages to it. VoiceOver
/// reads it as one adjustable "Column 2 of 3, In Progress".
private struct KanbanPageDots: View {
    let lanes: [KanbanLane]
    @Binding var visibleColumn: String?

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var current: Int {
        lanes.firstIndex { $0.id == visibleColumn } ?? 0
    }

    var body: some View {
        if lanes.count > 1 {
            HStack(spacing: Tokens.Space.small) {
                ForEach(Array(lanes.enumerated()), id: \.element.id) { index, lane in
                    Circle()
                        .fill(index == current ? Tokens.Text.primary.color : Tokens.Line.border.color)
                        .frame(width: Tokens.Space.small, height: Tokens.Space.small)
                        .frame(minWidth: Tokens.Space.section, minHeight: Tokens.Size.minimumHitArea)
                        .contentShape(.rect)
                        .onTapGesture { page(to: lane.id) }
                }
            }
            .frame(maxWidth: .infinity)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(TasksCopy.kanbanPage(current + 1, of: lanes.count, title: lanes[current].column.title))
            .accessibilityAdjustableAction { direction in
                switch direction {
                case .increment: if current + 1 < lanes.count { page(to: lanes[current + 1].id) }
                case .decrement: if current > 0 { page(to: lanes[current - 1].id) }
                @unknown default: break
                }
            }
            .accessibilityIdentifier("tasks.kanban.pageDots")
        }
    }

    private func page(to id: String) {
        withAnimation(Tokens.animation(.normal, .moving, reduceMotion: reduceMotion)) {
            visibleColumn = id
        }
    }
}

extension TasksCopy {
    static func kanbanPage(_ index: Int, of total: Int, title: String) -> String {
        "Column \(index) of \(total), \(title)"
    }
}
