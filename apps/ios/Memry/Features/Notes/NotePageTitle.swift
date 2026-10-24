import MemryCore
import SwiftUI

// The title under a note's cover: an editor when the page can write metadata,
// a plain header otherwise. Split from `NoteReadView.swift`.

struct NotePageTitle: View {
    let model: NoteReadViewModel
    let detail: NoteDetail
    let metadataModel: NoteMetadataViewModel
    /// Return in the title moves the caret to the body. `nil` on a page whose
    /// body is read only.
    let returnToBody: (() -> Void)?

    var body: some View {
        if metadataModel.canEdit {
            NoteTitleEditor(
                title: detail.summary.title,
                icon: model.metadata?.icon,
                canEdit: true,
                rename: { title in
                    Task {
                        await metadataModel.rename(to: title, current: model.displayTitle)
                        await model.reload()
                    }
                },
                setIcon: { icon in
                    Task {
                        await metadataModel.setIcon(icon)
                        await model.reload()
                    }
                },
                returnToBody: returnToBody
            )
        } else {
            NoteHeader(title: model.displayTitle, summary: detail.summary)
        }
    }
}
