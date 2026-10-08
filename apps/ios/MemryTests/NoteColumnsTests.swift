//
//  NoteColumnsTests.swift
//  Side-by-side columns (§12.9): how the flat block list's `columnList` and
//  `column` rows are grouped for drawing, and that neither is ever edited.
//

import Foundation
import MemryCore
import Testing
import UIKit

@testable import Memry

private func block(
    _ id: String?, _ kind: String = "paragraph", depth: UInt32 = 0, props: [String: String] = [:], text: String = ""
) -> Block {
    Block(
        id: id, kind: kind, depth: depth,
        props: props.sorted { $0.key < $1.key }.map { BlockProp(name: $0.key, value: $0.value) },
        inline: text.isEmpty ? [] : [InlineRun(text: text, marks: [], markAttrs: [:], target: nil)]
    )
}

/// The core's shape: the list and its columns carry no block id, only an
/// `id` prop.
private func columnList(_ id: String, depth: UInt32 = 0) -> Block {
    block(nil, "columnList", depth: depth, props: ["id": id, "regionId": "", "settings": ""])
}

private func column(_ id: String, depth: UInt32 = 1, width: String = "1") -> Block {
    block(nil, "column", depth: depth, props: ["id": id, "width": width])
}

/// Each item as text: a row as its block id, a group as its columns' rows.
private func shape(_ items: [NoteColumns.Item]) -> [String] {
    items.map { item in
        switch item {
        case let .row(row):
            "\(row.block.id ?? row.block.kind)@\(row.indent)"
        case let .columns(group):
            "[\(group.columns.map { shape($0.items).joined(separator: ",") }.joined(separator: " | "))]@\(group.indent)"
        }
    }
}

private func layout(_ blocks: [Block]) -> [NoteColumns.Item] {
    NoteColumns.layout(NoteBlockList.rows(of: blocks))
}

@Suite("Note columns layout")
struct NoteColumnsLayoutTests {
    private let twoColumns = [
        block("before"),
        columnList("cl"),
        column("c1", width: "0.5"),
        block("left", depth: 2),
        block("left-child", depth: 3),
        column("c2", width: "1.5"),
        block("right", depth: 2),
        block("after"),
    ]

    @Test func a_column_list_is_one_group_of_its_columns_blocks_in_order() {
        #expect(shape(layout(twoColumns)) == [
            "before@0",
            "[left@0,left-child@1 | right@0]@0",
            "after@0",
        ])
    }

    @Test func the_list_and_column_rows_draw_nothing_of_their_own() {
        let rows = layout(twoColumns).flatMap { item -> [NoteBlockList.Row] in
            switch item {
            case let .row(row): [row]
            case let .columns(group): group.columns.flatMap { column in
                column.items.compactMap { if case let .row(row) = $0 { row } else { nil } }
            }
            }
        }
        #expect(rows.allSatisfy { !NoteColumns.isStructural($0.block.kind) })
        #expect(rows.count == 5, "every block with words is still drawn")
    }

    @Test func a_columns_width_is_its_weight() throws {
        guard case let .columns(group) = layout(twoColumns)[1] else {
            Issue.record("expected the column group second")
            return
        }
        #expect(group.columns.map(\.weight) == [0.5, 1.5])
        #expect(NoteColumns.weight(of: column("c", width: "")) == 1)
        #expect(NoteColumns.weight(of: column("c", width: "-2")) == 1)
        #expect(NoteColumns.weight(of: column("c", width: "nan")) == 1)
        #expect(NoteColumns.weight(of: block(nil, "column")) == 1, "an absent width is the declared default")
    }

    @Test func numbering_starts_again_in_each_column() {
        let blocks = [
            columnList("cl"),
            column("c1"),
            block("a", "numberedListItem", depth: 2),
            block("b", "numberedListItem", depth: 2),
            column("c2"),
            block("c", "numberedListItem", depth: 2),
        ]
        #expect(NoteBlockList.rows(of: blocks).compactMap(\.marker) == ["1.", "2.", "1."])
    }

    @Test func a_column_list_nested_under_a_block_keeps_its_indent() {
        let blocks = [
            block("item", "bulletListItem"),
            columnList("cl", depth: 1),
            column("c1", depth: 2),
            block("x", depth: 3),
            column("c2", depth: 2),
            block("y", depth: 3),
        ]
        #expect(shape(layout(blocks)) == ["item@0", "[x@0 | y@0]@1"])
    }

    @Test func a_stray_column_draws_only_its_blocks() {
        // Not something a writer produces; nothing in it may be lost.
        let blocks = [column("c", depth: 0), block("x", depth: 1)]
        #expect(shape(layout(blocks)) == ["x@1"])
    }

    @Test func blocks_before_any_column_still_draw() {
        let blocks = [columnList("cl"), block("loose", depth: 1), column("c1"), block("x", depth: 2)]
        #expect(shape(layout(blocks)) == ["[loose@0 | x@0]@0"])
    }

    @Test func a_closed_toggle_hides_a_column_list_it_holds() {
        let blocks = [
            block("t", "toggleListItem", props: ["open": "false"]),
            columnList("cl", depth: 1),
            column("c1", depth: 2),
            block("x", depth: 3),
            block("after"),
        ]
        #expect(shape(layout(blocks)) == ["t@0", "after@0"])
    }

    @Test func a_note_without_columns_lays_out_as_before() {
        let blocks = [block("a"), block("b", "bulletListItem", depth: 1), block("c")]
        #expect(shape(layout(blocks)) == ["a@0", "b@1", "c@0"])
    }
}

@Suite("Note columns placement")
struct NoteColumnsPlacementTests {
    private let blocks = [
        block("top"),
        columnList("cl"),
        column("c1"),
        block("left", depth: 2),
        block("left-child", depth: 3),
        column("c2"),
        block("right", depth: 2),
    ]

    @Test func a_block_anywhere_under_a_column_is_inside_one() {
        #expect(!NoteColumns.isInsideColumn(0, in: blocks))
        #expect(NoteColumns.isInsideColumn(3, in: blocks))
        #expect(NoteColumns.isInsideColumn(4, in: blocks), "a nested block is still in the column")
        #expect(NoteColumns.isInsideColumn(6, in: blocks))
        #expect(!NoteColumns.isInsideColumn(1, in: blocks), "the list itself is not in a column")
    }

    @Test func the_caret_goes_to_the_lists_first_block() {
        #expect(NoteColumns.firstBlockId(inColumnList: "cl", in: blocks) == "left")
        #expect(NoteColumns.firstBlockId(inColumnList: "missing", in: blocks) == nil)
    }

    @Test func a_list_with_no_blocks_hands_over_no_block_after_it() {
        let empty = [columnList("cl"), column("c1"), column("c2"), block("after")]
        #expect(NoteColumns.firstBlockId(inColumnList: "cl", in: empty) == nil)
    }
}

@Suite("Note columns are never edited as text")
@MainActor
struct NoteColumnsEditingTests {
    @Test func no_block_action_retypes_or_colours_a_layout_row() {
        for row in [columnList("cl"), column("c1")] {
            let target = BlockActionTarget(block: row, siblings: BlockSiblings())
            #expect(!target.canTurnInto)
            #expect(!target.canColour)
            #expect(target.blockId == nil, "no id, so no move, duplicate or delete can be sent")
        }
    }

    @Test func markdown_shortcuts_do_nothing_on_a_layout_row() {
        for kind in NoteColumns.structuralKinds {
            #expect(MarkdownShortcut.block("# ", in: kind) == nil)
            #expect(MarkdownShortcut.mark("**bold**", in: kind) == nil)
        }
        #expect(MarkdownShortcut.block("# ", in: "paragraph") != nil, "a block in a column keeps its shortcuts")
    }

    @Test func the_slash_menu_is_empty_on_a_layout_row() {
        let session = EditorSession()
        let row = columnList("cl")
        session.blocks = { [row] }
        let style = BlockText.Style(font: .systemFont(ofSize: 17), ink: .label, titleExists: nil)
        let field = BlockField(block: row, session: session, style: style, alignment: .natural)
        session.focusChanged(to: field)
        #expect(session.slashSuggestions(query: "").isEmpty)
        withExtendedLifetime(field) {}
    }

    @Test func a_block_in_a_column_moves_only_among_its_own_columns_blocks() {
        let blocks = [
            columnList("cl"), column("c1"), block("a", depth: 2), block("b", depth: 2),
            column("c2"), block("c", depth: 2),
        ]
        #expect(BlockSiblings.of(3, in: blocks) == BlockSiblings(previous: "a", next: nil))
        #expect(BlockSiblings.of(5, in: blocks) == BlockSiblings(previous: nil, next: nil))
    }

    @Test func a_block_beside_a_column_list_offers_no_move_across_it() {
        // The list has no block id, so a move would have to address it.
        let blocks = [block("a"), columnList("cl"), column("c1"), block("x", depth: 2), block("b")]
        #expect(BlockSiblings.of(0, in: blocks).next == nil)
        #expect(BlockSiblings.of(4, in: blocks).previous == nil)
    }
}
