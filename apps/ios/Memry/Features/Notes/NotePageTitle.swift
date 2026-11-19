import MemryCore
import SwiftUI

// The title under a note's cover: an editor when the page can write metadata,
// a plain header otherwise. Split from `NoteReadView.swift`.

struct NotePageTitle: View {
    let model: NoteReadViewModel
    let detail: NoteDetail
    let metadataModel: NoteMetadataViewModel
    /// Return in the title moves the caret to the body, with the keys the
    /// title held since. `nil` on a page whose body is read only.
    let returnToBody: ((@escaping TitleBurst.Take) -> Void)?

    var body: some View {
        if metadataModel.canEdit {
            NoteTitleEditor(
                noteId: model.route.id,
                title: detail.summary.title,
                icon: model.metadata?.icon,
                canEdit: true,
                rename: { metadataModel.save(title: $0, current: model.displayTitle) },
                setIcon: { icon in
                    Task {
                        await metadataModel.setIcon(icon)
                        await model.reload()
                    }
                },
                returnToBody: returnToBody,
                draftChanged: { metadataModel.titleDraft = $0 }
            )
        } else {
            NoteHeader(title: model.displayTitle, summary: detail.summary)
        }
    }
}
