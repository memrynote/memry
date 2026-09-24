import MemryCore
import SwiftUI

// TP046. The dialogs `TasksStore+Subtasks.swift` raises, hosted once at the
// Tasks root by `subtaskPrompts(store:)`:
//
// - `.completeParent` (`complete-parent-dialog.tsx`): all / parent only.
// - `.allSubtasksDone` (`all-subtasks-complete-dialog.tsx`): complete the
//   parent or keep it open.
// - `.deleteParent` (`delete-parent-dialog.tsx`): all / keep as tasks.
// - duplicate with subtasks (`duplicate-with-subtasks-dialog.tsx`) and the
//   parent picker, raised through `scratch`.
//
// `store.prompt` is shared with the repeat block, so each binding reads only
// its own case and clears only its own case.

struct SubtaskPrompts: ViewModifier {
    let store: TasksStore

    func body(content: Content) -> some View {
        content
            .confirmationDialog(
                TasksCopy.subtaskCompleteParentTitle,
                isPresented: promptBinding(store, shown: completeParentId != nil),
                titleVisibility: .visible,
                presenting: completeParentId.flatMap { store.items[$0] }
            ) { parent in
                Button(TasksCopy.subtaskCompleteParentAll) {
                    Task { await store.completeParent(parent.id, withSubtasks: true) }
                }
                .accessibilityIdentifier("tasks.subtasks.completeParent.all")
                Button(TasksCopy.subtaskCompleteParentOnly) {
                    Task { await store.completeParent(parent.id, withSubtasks: false) }
                }
                .accessibilityIdentifier("tasks.subtasks.completeParent.parentOnly")
                Button(TasksCopy.subtaskCancel, role: .cancel) { store.prompt = nil }
            } message: { parent in
                Text(TasksCopy.subtaskCompleteParentMessage(
                    title: parent.title,
                    open: store.openSubtasks(of: parent.id).map(\.title)
                ))
            }
            .alert(
                TasksCopy.subtaskAllCompleteTitle,
                isPresented: promptBinding(store, shown: allDoneParentId != nil),
                presenting: allDoneParentId.flatMap { store.items[$0] }
            ) { parent in
                Button(TasksCopy.subtaskKeepParentOpen, role: .cancel) { store.keepParentOpen() }
                    .accessibilityIdentifier("tasks.subtasks.allDone.keepOpen")
                Button(TasksCopy.subtaskCompleteParentNow) {
                    Task { await store.completeParentAfterSubtasks(parent.id) }
                }
                .accessibilityIdentifier("tasks.subtasks.allDone.complete")
            } message: { parent in
                Text(TasksCopy.subtaskAllDoneMessage(
                    title: parent.title,
                    count: store.subtasks(of: parent.id).count
                ))
            }
            .modifier(SubtaskDeleteParentPrompt(store: store))
            .modifier(SubtaskScratchPrompts(store: store))
    }

    private var completeParentId: String? {
        if case let .completeParent(id) = store.prompt { return id }
        return nil
    }

    private var allDoneParentId: String? {
        if case let .allSubtasksDone(id) = store.prompt { return id }
        return nil
    }
}

/// Shown while the store's prompt is this block's case; dismissing clears it
/// unless another case has replaced it meanwhile.
@MainActor
private func promptBinding(_ store: TasksStore, shown: Bool) -> Binding<Bool> {
    let current = store.prompt
    return Binding(
        get: { shown },
        set: { isShown in
            if !isShown, store.prompt == current { store.prompt = nil }
        }
    )
}

/// `.deleteParent` (`delete-parent-dialog.tsx`).
private struct SubtaskDeleteParentPrompt: ViewModifier {
    let store: TasksStore

    func body(content: Content) -> some View {
        content
            .confirmationDialog(
                TasksCopy.subtaskDeleteParentTitle,
                isPresented: promptBinding(store, shown: deleteParentId != nil),
                titleVisibility: .visible,
                presenting: deleteParentId.flatMap { store.items[$0] }
            ) { parent in
                Button(TasksCopy.subtaskDeleteParentAll, role: .destructive) {
                    Task { await store.deleteParent(parent.id, keepSubtasks: false) }
                }
                .accessibilityIdentifier("tasks.subtasks.deleteParent.all")
                Button(TasksCopy.subtaskDeleteParentKeep) {
                    Task { await store.deleteParent(parent.id, keepSubtasks: true) }
                }
                .accessibilityIdentifier("tasks.subtasks.deleteParent.keep")
                Button(TasksCopy.subtaskCancel, role: .cancel) { store.prompt = nil }
            } message: { parent in
                Text(TasksCopy.subtaskDeleteParentMessage(
                    title: parent.title,
                    count: store.subtasks(of: parent.id).count
                ))
            }
    }

    private var deleteParentId: String? {
        if case let .deleteParent(id) = store.prompt { return id }
        return nil
    }
}

/// The duplicate dialog and the parent picker, raised through `scratch`.
private struct SubtaskScratchPrompts: ViewModifier {
    let store: TasksStore

    func body(content: Content) -> some View {
        let duplicating = store.scratch[TasksStore.duplicateScratchKey].flatMap { store.items[$0] }
        let picking = store.scratch[TasksStore.parentPickerScratchKey].flatMap { store.items[$0] }
        content
            .confirmationDialog(
                TasksCopy.subtaskDuplicateTitle,
                isPresented: scratchBinding(TasksStore.duplicateScratchKey, shown: duplicating != nil),
                titleVisibility: .visible,
                presenting: duplicating
            ) { task in
                Button(TasksCopy.subtaskDuplicateWithItems(store.subtasks(of: task.id).count + 1)) {
                    Task { await store.duplicate(task.id, withSubtasks: true) }
                }
                .accessibilityIdentifier("tasks.subtasks.duplicate.withSubtasks")
                Button(TasksCopy.subtaskDuplicateTaskOnly) {
                    Task { await store.duplicate(task.id, withSubtasks: false) }
                }
                .accessibilityIdentifier("tasks.subtasks.duplicate.taskOnly")
                Button(TasksCopy.subtaskCancel, role: .cancel) {
                    store.scratch[TasksStore.duplicateScratchKey] = nil
                }
            } message: { task in
                Text(TasksCopy.subtaskDuplicateMessage(title: task.title))
            }
            .sheet(isPresented: scratchBinding(TasksStore.parentPickerScratchKey, shown: picking != nil)) {
                if let picking {
                    ParentPickerSheet(task: picking, store: store)
                }
            }
    }

    private func scratchBinding(_ key: String, shown: Bool) -> Binding<Bool> {
        Binding(
            get: { shown },
            set: { if !$0 { store.scratch[key] = nil } }
        )
    }
}
