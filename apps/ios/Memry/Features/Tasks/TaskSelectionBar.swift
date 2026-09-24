import MemryCore
import SwiftUI

// TP047. The multi-select bulk bar (`bulk-actions/bulk-action-toolbar.tsx`)
// and its hardware keyboard (`pages/tasks.tsx` keydown handler).
//
// The bar appears while anything is selected, as desktop's toolbar does:
// count, select all / deselect all, Complete, Priority, Due Date, Move to,
// Status (when the selection shares one project), Archive or Unarchive (in the
// archived scope), Delete (asks first), and Cancel selection. The actions
// scroll sideways so every label stays readable at the largest text sizes.
// Each write is one core `bulk*` call with one Undo toast (TP051).

/// TP047 — the multi-select bulk bar.
struct TaskSelectionBar: View {
    let store: TasksStore
    @Binding var selection: Set<String>
    let visibleIds: [String]

    @State private var isConfirmingDelete = false
    @State private var isPickingDate = false

    var body: some View {
        if !selection.isEmpty {
            HStack(spacing: Tokens.Space.small) {
                count
                ScrollView(.horizontal) {
                    HStack(spacing: Tokens.Space.tight) { actions }
                }
                .scrollIndicators(.hidden)
                Button {
                    selection.removeAll()
                } label: {
                    Image(systemName: "xmark")
                        .font(Tokens.Typography.body.font)
                        .foregroundStyle(Tokens.Text.secondary.color)
                        .frame(minWidth: Tokens.Size.minimumHitArea, minHeight: Tokens.Size.minimumHitArea)
                        .contentShape(.rect)
                }
                .accessibilityLabel(TasksCopy.cancelSelection)
                .accessibilityIdentifier("tasks.selection.clear")
            }
            .padding(.horizontal, Tokens.Space.small)
            .padding(.vertical, Tokens.Space.tight)
            .blockSurface(radius: Tokens.Radius.panel)
            .overlay {
                RoundedRectangle(cornerRadius: Tokens.Radius.panel)
                    .strokeBorder(Tokens.Line.border.color, lineWidth: Tokens.Size.hairline)
            }
            .padding(.horizontal, Tokens.Space.inset)
            .padding(.bottom, Tokens.Space.small)
            .accessibilityElement(children: .contain)
            .accessibilityLabel(TasksCopy.bulkActions)
            .accessibilityIdentifier("tasks.selection.bar")
            .taskSelectionDeleteDialog(store: store, selection: $selection, isPresented: $isConfirmingDelete)
            .sheet(isPresented: $isPickingDate) { dateSheet }
        }
    }

    private var write: TaskSelectionWrite {
        TaskSelectionWrite(store: store, selection: $selection)
    }

    /// "3 selected"; tapping it selects all or clears (`toggleSelectAll`).
    private var count: some View {
        let all = selection.containsAll(of: visibleIds)
        return Button {
            selection.toggleAll(in: visibleIds)
        } label: {
            Text(TasksCopy.selectedCount(selection.count))
                .font(Tokens.Typography.label.font)
                .monospacedDigit()
                .foregroundStyle(Tokens.Text.primary.color)
                .padding(.horizontal, Tokens.Space.small)
                .frame(minHeight: Tokens.Size.minimumHitArea)
                .background(Tokens.Canvas.surfaceActive.color, in: .rect(cornerRadius: Tokens.Radius.control))
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityHint(all ? TasksCopy.deselectAll : TasksCopy.selectAll)
        .accessibilityIdentifier("tasks.selection.count")
    }

    @ViewBuilder private var actions: some View {
        Button {
            write { await store.completeSelection($0) }
        } label: {
            TaskBulkActionLabel(title: TasksCopy.bulkComplete, systemImage: "checkmark")
        }
        .accessibilityIdentifier("tasks.bulk.complete")

        TaskBulkPriorityMenu(store: store, write: write)
        TaskBulkDueMenu(store: store, write: write) { isPickingDate = true }
        TaskBulkMoveMenu(store: store, write: write)

        let statuses = store.bulkStatuses(selection)
        if !statuses.isEmpty {
            TaskBulkStatusMenu(store: store, statuses: statuses, write: write)
        }

        if store.isArchivedScope {
            Button {
                write { await store.unarchiveSelection($0) }
            } label: {
                TaskBulkActionLabel(title: TasksCopy.bulkUnarchive, systemImage: "arrow.uturn.backward")
            }
            .accessibilityIdentifier("tasks.bulk.unarchive")
        } else {
            Button {
                write { await store.archiveSelection($0) }
            } label: {
                TaskBulkActionLabel(title: TasksCopy.bulkArchive, systemImage: "archivebox")
            }
            .accessibilityIdentifier("tasks.bulk.archive")
        }

        Button {
            isConfirmingDelete = true
        } label: {
            TaskBulkActionLabel(title: TasksCopy.bulkDelete, systemImage: "trash", isDestructive: true)
        }
        .accessibilityIdentifier("tasks.bulk.delete")
    }

    /// Pick a date, and optionally a time, for the whole selection.
    private var dateSheet: some View {
        TaskDateSheet(
            title: TasksCopy.setDueDateFor(selection.count),
            date: nil,
            time: nil,
            allowsTime: true,
            store: store
        ) { date, time in
            isPickingDate = false
            write { await store.setDue(of: $0, date: date, time: time) }
        }
    }
}

extension View {
    /// TP047 — hardware keyboard: Cmd+A, Cmd+Return, Cmd+Delete, Esc.
    func taskKeyboardShortcuts(
        store: TasksStore,
        selection: Binding<Set<String>>,
        visibleIds: [String]
    ) -> some View {
        modifier(TaskSelectionKeyboard(store: store, selection: selection, visibleIds: visibleIds))
    }
}
