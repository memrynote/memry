//
//  ChecklistTaskMenu.swift
//  TP054. A checklist item's task actions: convert it into a task, and
//  nest it (Tab) or lift it (Shift-Tab).
//
//  Desktop converts a checklist item from its context menu
//  (`ContentArea.tsx`, `handleEditorContextMenu` -> `convertCheckboxToTask`)
//  and makes it a subtask when it is nested directly under a task line
//  (`analyzeTaskIntents`). Both rules are the core's
//  (`Tasks.convertChecklistItem`); the phone has no Tab key, so the nesting
//  is offered here as Indent / Outdent beside the conversion.
//

import SwiftUI

/// Adds the task actions to one checklist item, when the screen can write.
struct ChecklistTaskMenu: ViewModifier {
    /// The item's block id; `nil` draws the item without actions.
    let blockId: String?

    @Environment(\.noteTasks) private var actions

    func body(content: Content) -> some View {
        if let blockId, let actions, hasAny(actions) {
            content
                .contextMenu {
                    if let convert = actions.convert {
                        Button {
                            convert(blockId)
                        } label: {
                            Label(TasksCopy.convertToTask, systemImage: "checkmark.circle.badge.plus")
                        }
                        .accessibilityIdentifier("tasks.noteChecklist.convert")
                    }
                    if let indent = actions.indent {
                        Button {
                            indent(blockId)
                        } label: {
                            Label(TasksCopy.indentLine, systemImage: "increase.indent")
                        }
                    }
                    if let outdent = actions.outdent {
                        Button {
                            outdent(blockId)
                        } label: {
                            Label(TasksCopy.outdentLine, systemImage: "decrease.indent")
                        }
                    }
                }
                .accessibilityActions {
                    if let convert = actions.convert {
                        Button(TasksCopy.convertToTask) { convert(blockId) }
                    }
                    if let indent = actions.indent {
                        Button(TasksCopy.indentLine) { indent(blockId) }
                    }
                    if let outdent = actions.outdent {
                        Button(TasksCopy.outdentLine) { outdent(blockId) }
                    }
                }
                .disabled(actions.isBusy(blockId))
                .accessibilityIdentifier("tasks.noteChecklist.item")
        } else {
            content
        }
    }

    private func hasAny(_ actions: NoteTaskBridge) -> Bool {
        actions.convert != nil || actions.indent != nil || actions.outdent != nil
    }
}
