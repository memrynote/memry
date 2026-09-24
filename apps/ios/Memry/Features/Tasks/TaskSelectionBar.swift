import MemryCore
import SwiftUI

// TP047, redesigned (RD14). Select mode's bottom toolbar (Paper artboard 14):
// a glass bottom bar replaces the tab bar with Complete, Date, Move and More.
// More holds Priority, Status (when the selection shares one project),
// Archive or Unarchive (in the archived scope) and Delete (asks first).
// Each write is one core `bulk*` call with one Undo toast (TP051) and clears
// the written ids from the selection (desktop's `onComplete: deselectAll`).

/// TP047 — the select-mode bottom toolbar.
struct TaskSelectionToolbar: ToolbarContent {
    let store: TasksStore
    @Binding var selection: Set<String>

    /// One item, so the four actions share one glass bar (as the tab bar did).
    var body: some ToolbarContent {
        ToolbarItem(placement: .bottomBar) {
            HStack(spacing: 0) {
                Button {
                    TaskSelectionWrite(store: store, selection: $selection).callAsFunction {
                        await store.completeSelection($0)
                    }
                } label: {
                    TaskBulkActionLabel(title: TasksCopy.bulkComplete, systemImage: "checkmark.circle")
                }
                .disabled(selection.isEmpty)
                .accessibilityIdentifier("tasks.bulk.complete")
                .frame(maxWidth: .infinity)
                TaskSelectionDateItem(store: store, selection: $selection)
                    .frame(maxWidth: .infinity)
                TaskBulkMoveMenu(store: store, write: TaskSelectionWrite(store: store, selection: $selection))
                    .disabled(selection.isEmpty)
                    .frame(maxWidth: .infinity)
                TaskSelectionMoreItem(store: store, selection: $selection)
                    .frame(maxWidth: .infinity)
            }
        }
    }
}

/// Date: the presets, a picked date and time, or no date.
private struct TaskSelectionDateItem: View {
    let store: TasksStore
    @Binding var selection: Set<String>
    @State private var isPickingDate = false

    var body: some View {
        TaskBulkDueMenu(store: store, write: TaskSelectionWrite(store: store, selection: $selection)) {
            isPickingDate = true
        }
        .disabled(selection.isEmpty)
        .sheet(isPresented: $isPickingDate) {
            TaskDateSheet(
                title: TasksCopy.setDueDateFor(selection.count),
                date: nil,
                time: nil,
                allowsTime: true,
                store: store
            ) { date, time in
                isPickingDate = false
                TaskSelectionWrite(store: store, selection: $selection).callAsFunction {
                    await store.setDue(of: $0, date: date, time: time)
                }
            }
        }
    }
}

/// More: priority, status, archive or unarchive, delete.
private struct TaskSelectionMoreItem: View {
    let store: TasksStore
    @Binding var selection: Set<String>
    @State private var isConfirmingDelete = false

    private var write: TaskSelectionWrite { TaskSelectionWrite(store: store, selection: $selection) }

    var body: some View {
        Menu {
            TaskBulkPriorityMenu(store: store, write: write)
            let statuses = store.bulkStatuses(selection)
            if !statuses.isEmpty {
                TaskBulkStatusMenu(store: store, statuses: statuses, write: write)
            }
            Section {
                if store.isArchivedScope {
                    Button(TasksCopy.bulkUnarchive, systemImage: "tray.and.arrow.up") {
                        write { await store.unarchiveSelection($0) }
                    }
                    .accessibilityIdentifier("tasks.bulk.unarchive")
                } else {
                    Button(TasksCopy.bulkArchive, systemImage: "archivebox") {
                        write { await store.archiveSelection($0) }
                    }
                    .accessibilityIdentifier("tasks.bulk.archive")
                }
                Button(TasksCopy.bulkDelete, systemImage: "trash", role: .destructive) {
                    isConfirmingDelete = true
                }
                .accessibilityIdentifier("tasks.bulk.delete")
            }
        } label: {
            TaskBulkActionLabel(title: TasksCopy.bulkMore, systemImage: "ellipsis.circle")
        }
        .disabled(selection.isEmpty)
        .accessibilityIdentifier("tasks.bulk.more")
        .taskSelectionDeleteDialog(store: store, selection: $selection, isPresented: $isConfirmingDelete)
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
