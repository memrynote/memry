import MemryCore

extension NoteEditorViewModel {
    /// Puts the caret in the body: its first block (Return in the title) or
    /// its end (a tap under it). A body with nowhere to type gets a new empty
    /// paragraph, as desktop does. `carrying` takes the keys the title held
    /// since its Return, which the block types as it takes the caret.
    func focusBody(in blocks: [Block], atEnd: Bool, carrying held: (() -> String?)? = nil) async {
        let target = atEnd ? blocks.last : blocks.first
        let typable = target.map { block in
            atEnd
                ? block.kind == "paragraph" && block.inline.allSatisfy(\.text.isEmpty)
                : ["paragraph", "heading", "bulletListItem", "numberedListItem", "checkListItem", "quote"]
                    .contains(block.kind)
        } ?? false
        let id = typable ? target?.id : await insertParagraph(after: blocks.last?.id)
        guard let id else { return }
        session.titleBurst = held.map { TitleBurst(target: id, take: $0) }
        session.focus(id)
    }
}
