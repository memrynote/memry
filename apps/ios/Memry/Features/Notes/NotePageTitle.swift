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

    /// A Return pressed before the page walked the body's blocks (#5119).
    @State private var heldReturn: TitleBurst.Take?

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
                returnToBody: returnToBody.map { hand in
                    { held in
                        // The keys go to the first block, which only the
                        // block walk knows. Before it, the body made a
                        // paragraph above the note's own and lost them
                        // (#5119): the title holds them until the walk lands.
                        if model.blocksRead || !detail.body.present { hand(held) } else { heldReturn = held }
                    }
                },
                draftChanged: { metadataModel.titleDraft = $0 }
            )
            .onChange(of: model.blocksRead) { _, read in
                guard read, let held = heldReturn, let returnToBody else { return }
                heldReturn = nil
                returnToBody(held)
            }
        } else {
            NoteHeader(title: model.displayTitle, summary: detail.summary)
        }
    }
}
