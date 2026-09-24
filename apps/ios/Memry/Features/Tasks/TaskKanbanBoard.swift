import MemryCore
import SwiftUI

// TP049. The kanban board (desktop `components/tasks/kanban/kanban-board.tsx`).
//
// **Paged columns.** A phone shows one column at a time; the columns page
// horizontally and the next one peeks in at the edge. A strip of column chips
// above says where you are, pages on tap and takes drops, so a card can move
// to a column that is off screen (dragging across a paged scroll view does
// not scroll it). VoiceOver and anyone who prefers not to drag get the same
// move through each card's "Move to" actions.

/// TP049 — the kanban board.
struct TaskKanbanBoard: View {
    let store: TasksStore

    @State private var dueBuckets: [String: String] = [:]
    @State private var visibleColumn: String?

    var body: some View {
        let lanes = store.kanbanLanes(dueBuckets: dueBuckets)
        VStack(spacing: Tokens.Space.small) {
            KanbanBoardHeader(store: store, lanes: lanes, visibleColumn: $visibleColumn, onDrop: drop)
            ScrollView(.horizontal) {
                LazyHStack(alignment: .top, spacing: Tokens.Space.medium) {
                    ForEach(lanes) { lane in
                        KanbanColumnView(
                            store: store,
                            lane: lane,
                            allColumns: lanes.map(\.column),
                            onDrop: drop
                        )
                        .containerRelativeFrame(.horizontal)
                        .id(lane.id)
                    }
                }
                .scrollTargetLayout()
            }
            .scrollTargetBehavior(.viewAligned)
            .scrollPosition(id: $visibleColumn)
            .contentMargins(.horizontal, Tokens.Space.section, for: .scrollContent)
            .scrollIndicators(.hidden)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(TasksCopy.kanbanBoard)
        .accessibilityIdentifier("tasks.kanban.board")
        .task(id: BucketKey(result: store.result, mode: store.kanbanEffectiveMode)) {
            dueBuckets = store.kanbanEffectiveMode == .dueDate ? await store.kanbanLoadDueBuckets() : [:]
        }
        .onChange(of: store.kanbanEffectiveMode) { _, _ in visibleColumn = nil }
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

/// The column-mode picker and the column strip.
private struct KanbanBoardHeader: View {
    let store: TasksStore
    let lanes: [KanbanLane]
    @Binding var visibleColumn: String?
    let onDrop: (String, KanbanColumn) -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        HStack(spacing: Tokens.Space.small) {
            modePicker
            ScrollView(.horizontal) {
                HStack(spacing: Tokens.Space.small) {
                    ForEach(lanes) { lane in
                        KanbanStripChip(
                            lane: lane,
                            isVisible: lane.id == (visibleColumn ?? lanes.first?.id),
                            onTap: { page(to: lane.id) },
                            onDrop: onDrop
                        )
                    }
                }
            }
            .scrollIndicators(.hidden)
            .accessibilityLabel(TasksCopy.kanbanColumnsLabel)
        }
        .padding(.horizontal, Tokens.Space.inset)
    }

    private var modePicker: some View {
        Menu {
            Picker(TasksCopy.kanbanGroupBy, selection: modeBinding) {
                ForEach(KanbanColumnMode.pickable) { mode in
                    Text(TasksCopy.kanbanModeLabel(mode)).tag(mode)
                }
            }
        } label: {
            // Icon only at accessibility sizes, where the name would break
            // mid-word beside the strip; the spoken label carries it.
            Label(TasksCopy.kanbanModeLabel(store.kanbanMode), systemImage: "rectangle.split.3x1")
                .labelStyle(ModeLabelStyle(iconOnly: typeSize.isAccessibilitySize))
                .font(Tokens.Typography.label.font)
                .foregroundStyle(Tokens.Text.secondary.color)
                .frame(minWidth: Tokens.Size.minimumHitArea, minHeight: Tokens.Size.minimumHitArea)
        }
        .accessibilityLabel("\(TasksCopy.kanbanGroupBy): \(TasksCopy.kanbanModeLabel(store.kanbanMode))")
        .accessibilityIdentifier("tasks.kanban.columnMode")
    }

    private var modeBinding: Binding<KanbanColumnMode> {
        Binding(
            get: { store.kanbanMode == .canonical ? .status : store.kanbanMode },
            set: { store.setKanbanMode($0) }
        )
    }

    private func page(to id: String) {
        withAnimation(Tokens.animation(.normal, .moving, reduceMotion: reduceMotion)) {
            visibleColumn = id
        }
    }
}

/// One chip of the strip: the column's name and count; tap pages to it, a
/// dropped card moves there.
private struct KanbanStripChip: View {
    let lane: KanbanLane
    let isVisible: Bool
    let onTap: () -> Void
    let onDrop: (String, KanbanColumn) -> Void

    @State private var isTargeted = false

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: Tokens.Space.tight) {
                Circle()
                    .fill(lane.column.tint)
                    .frame(width: Tokens.Space.small, height: Tokens.Space.small)
                    .accessibilityHidden(true)
                Text(lane.column.title)
                    .lineLimit(1)
                Text("\(lane.tasks.count)")
                    .monospacedDigit()
                    .foregroundStyle(Tokens.Text.tertiary.color)
            }
            .font(Tokens.Typography.label.font)
            .foregroundStyle(isVisible ? Tokens.Text.primary.color : Tokens.Text.secondary.color)
            .padding(.horizontal, Tokens.Space.medium)
            .frame(minHeight: Tokens.Size.minimumHitArea)
            .background(background, in: .rect(cornerRadius: Tokens.Radius.control))
            .overlay {
                RoundedRectangle(cornerRadius: Tokens.Radius.control)
                    .strokeBorder(isTargeted ? Tokens.Line.focus.color : .clear, lineWidth: Tokens.Size.hairline)
            }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .dropDestination(for: String.self) { ids, _ in
            guard let id = ids.first else { return false }
            onDrop(id, lane.column)
            return true
        } isTargeted: { isTargeted = $0 }
        .accessibilityLabel(TasksCopy.kanbanColumnSummary(lane.column.title, count: lane.tasks.count))
        .accessibilityAddTraits(isVisible ? .isSelected : [])
        .accessibilityIdentifier("tasks.kanban.strip.\(lane.id)")
    }

    private var background: Color {
        isVisible || isTargeted ? Tokens.Canvas.surfaceActive.color : Tokens.Canvas.surface.color
    }
}

private struct ModeLabelStyle: LabelStyle {
    let iconOnly: Bool

    func makeBody(configuration: Configuration) -> some View {
        if iconOnly {
            configuration.icon
        } else {
            HStack(spacing: Tokens.Space.tight) {
                configuration.icon
                configuration.title.lineLimit(1)
            }
        }
    }
}
