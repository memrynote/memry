import MemryCore
import SwiftUI
import UIKit

// The flat block list prepared for drawing, split from `NoteBlockView.swift`.

/// The flat block list, prepared for drawing.
///
/// Two things the list cannot say for itself and a single block cannot work
/// out alone: which cells belong to a table that draws itself, and what number
/// a list item is. Both need the sequence, so both are decided here rather
/// than inside `NoteBlockView`.
enum NoteBlockList {
    /// How many inline checkboxes appear in the blocks before this row.
    ///
    /// A cell's checkboxes are numbered across everything it holds, because
    /// that is how the core addresses them: the index counts the checkboxes
    /// in the cell, not the ones in a particular block (N605).
    static func checkboxesBefore(_ rowId: Int, in blocks: [Block]) -> Int {
        rows(of: blocks)
            .prefix { $0.id != rowId }
            .reduce(0) { total, row in
                total + row.block.inline.filter { $0.marks.contains("inlineCheckbox") }.count
            }
    }

    struct Row: Identifiable {
        let id: Int
        let block: Block
        /// The marker a numbered list item draws, already counted.
        let marker: String?
        /// For a toggle, whether it is showing its body.
        var isOpen = false
    }

    /// The rows to draw.
    ///
    /// A closed toggle hides everything nested under it, as desktop does:
    /// its body arrives as the following blocks one depth deeper, and drawing
    /// them anyway made "closed" mean nothing. `flipped` holds the toggles
    /// the reader has opened or closed since, against the document's `open`.
    static func rows(of blocks: [Block], flipped: Set<Int> = []) -> [Row] {
        var rows: [Row] = []
        // Per depth, so a nested list numbers itself and an outer list is not
        // disturbed by it.
        var counters: [UInt32: Int] = [:]
        // While inside a table, everything deeper belongs to it: the table
        // draws its own rows from `Notes.table`, and drawing the cells again
        // as loose paragraphs is what a flat list would otherwise do. Nothing
        // is dropped from the core — this is one surface choosing the richer
        // of two readings of the same content.
        var tableDepth: UInt32?
        // The depth of the closed toggle whose body is being skipped.
        var foldedDepth: UInt32?

        for (offset, block) in blocks.enumerated() {
            if let depth = foldedDepth {
                if block.depth > depth { continue }
                foldedDepth = nil
            }
            if let depth = tableDepth {
                if block.depth > depth { continue }
                tableDepth = nil
            }
            if block.kind == "table" { tableDepth = block.depth }

            var isOpen = false
            if block.kind == "toggleListItem" {
                let stored = block.props.first { $0.name == "open" }?.value == "true"
                isOpen = flipped.contains(offset) ? !stored : stored
                if !isOpen { foldedDepth = block.depth }
            }

            var marker: String?
            if block.kind == "numberedListItem" {
                let next = (counters[block.depth] ?? 0) + 1
                counters[block.depth] = next
                marker = "\(next)."
            } else {
                // Any other block ends the run, so a list after a paragraph
                // starts at one again. Deeper counters go too: a nested list
                // that ended restarts the next time one opens.
                counters = counters.filter { $0.key < block.depth }
            }

            rows.append(Row(id: offset, block: block, marker: marker, isOpen: isOpen))
        }
        return rows
    }
}
