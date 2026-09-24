import MemryCore
import SwiftUI

// The note screen's dialogs, split from `NoteReadView.swift` (line ceiling):
// N808's rename / delete / move, the broken wiki link notice, and TP054's
// failed task write.

/// Every alert and sheet the note screen raises, as one modifier.
struct NoteReadDialogs: ViewModifier {
    let model: NoteReadViewModel
    let actions: NotePageActions
    let taskActions: NoteTaskActions
    @Binding var renaming: Bool
    @Binding var renameDraft: String
    @Binding var moving: Bool
    @Binding var confirmingDelete: Bool
    @Binding var brokenLink: String?

    func body(content: Content) -> some View {
        content
            // N808's three write actions. Each is a sheet or an alert rather
            // than an inline control, because all three change the note as a
            // whole and none of them should be one stray tap away.
            .alert("Rename this note", isPresented: $renaming) {
                TextField("Title", text: $renameDraft)
                Button("Cancel", role: .cancel) {}
                Button("Rename") {
                    Task {
                        await actions.rename(to: renameDraft)
                        await model.reload()
                    }
                }
            }
            .alert("Delete this note?", isPresented: $confirmingDelete) {
                Button("Cancel", role: .cancel) {}
                Button("Delete", role: .destructive) {
                    Task { await actions.delete() }
                }
            } message: {
                // What actually happens, rather than a vague warning: a delete
                // travels to every device in the vault.
                Text("It will be removed from every device signed in to this vault.")
            }
            .sheet(isPresented: $moving) {
                NoteFolderPicker(current: model.folderPath) { folder in
                    moving = false
                    Task {
                        await actions.move(to: folder)
                        await model.reload()
                    }
                }
            }
            .alert(
                "There is no note called \u{201c}\(brokenLink ?? "")\u{201d}",
                isPresented: Binding(
                    get: { brokenLink != nil },
                    set: { if !$0 { brokenLink = nil } }
                )
            ) {
                Button("OK", role: .cancel) { brokenLink = nil }
            } message: {
                Text("The link points at a note this vault does not hold. You can create it on your computer.")
            }
            // TP054: a tick or a conversion that did not land. The line keeps
            // what the document says, which is the truth after a failure.
            .alert(
                taskActions.failure?.title ?? TasksCopy.taskActionFailedTitle,
                isPresented: Binding(
                    get: { taskActions.failure != nil },
                    set: { if !$0 { taskActions.dismissFailure() } }
                )
            ) {
                Button(TasksCopy.dismiss, role: .cancel) { taskActions.dismissFailure() }
            } message: {
                Text(taskActions.failure?.guidance ?? "")
            }
    }
}
