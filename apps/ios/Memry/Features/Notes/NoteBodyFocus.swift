import MemryCore

extension NoteEditorViewModel {
    /// Puts the caret in the body: its first block (Return in the title) or
    /// its end (a tap under it). A body with nowhere to type gets a new empty
    /// paragraph, as desktop does.
    func focusBody(in blocks: [Block], atEnd: Bool) async {
        let target = atEnd ? blocks.last : blocks.first
        let typable = target.map { block in
            atEnd
                ? block.kind == "paragraph" && block.inline.allSatisfy(\.text.isEmpty)
                : ["paragraph", "heading", "bulletListItem", "numberedListItem", "checkListItem", "quote"]
                    .contains(block.kind)
        } ?? false
        if typable, let id = target?.id {
            session.pendingFocus = id
        } else if let id = await insertParagraph(after: blocks.last?.id) {
            session.pendingFocus = id
        }
    }
}
