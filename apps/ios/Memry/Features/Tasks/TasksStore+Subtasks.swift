import MemryCore
import SwiftUI

// TP046 owns this file. Phase 3 placeholder: completes and deletes directly;
// the subtask block adds the complete-parent / delete-parent prompts.

extension TasksStore {
    /// The one entry point every checkbox uses to complete or reopen a task.
    func requestComplete(_ task: TaskItem) async {
        let id = task.id
        if task.isDone {
            await perform(TasksCopy.updated) { try $0.uncomplete(id: id) }
        } else {
            let now = localNow()
            await perform(TasksCopy.completed) { try $0.complete(id: id, localNow: now).change }
        }
    }

    /// The one entry point every delete action uses.
    func requestDelete(_ task: TaskItem) async {
        let id = task.id
        await perform(TasksCopy.deleted) { try $0.delete(id: id, promoteSubtasks: false) }
    }
}
