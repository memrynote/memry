import MemryCore
import SwiftUI

// Side-by-side columns (§12.9): a `columnList` holds two or more `column`s,
// and each column holds blocks.
//
// **In the flat block list they are rows with no text of their own.** The
// core's walk hands a column list over at depth `d`, its columns at `d + 1`
// and their blocks at `d + 2`. Neither row sits in a `blockContainer`, so
// both arrive with `id == nil` and their own id only as a prop, and this
// shell sends no edit addressed to either. Drawn as the flat list draws
// every other block, they were two empty paragraphs and a double indent.
//
// So this groups the rows instead: the column list becomes one group, each
// column the blocks it holds, and the blocks inside draw and edit exactly as
// they do anywhere else.

enum NoteColumns {
    /// The kinds that only lay other blocks out. Never a text field, never a
    /// target of a type change, a colour, a move or a delete.
    static let structuralKinds: Set<String> = ["columnList", "column"]

    static func isStructural(_ kind: String) -> Bool {
        structuralKinds.contains(kind)
    }

    /// A column's `width`: a flex-grow weight, `1` by default. A value that
    /// is missing, unreadable, or not a positive finite number weighs `1`,
    /// so a column is never drawn with no width at all.
    static func weight(of column: Block) -> Double {
        guard let raw = column.props.first(where: { $0.name == "width" })?.value,
              let value = Double(raw), value.isFinite, value > 0
        else { return 1 }
        return value
    }

    // MARK: - Where a block sits

    /// The index of the block `index` is nested in, or `nil` at the top.
    static func parentIndex(of index: Int, in blocks: [Block]) -> Int? {
        guard blocks.indices.contains(index) else { return nil }
        let depth = blocks[index].depth
        return blocks[..<index].lastIndex { $0.depth < depth }
    }

    /// Whether any block `index` is nested in is a column.
    static func isInsideColumn(_ index: Int, in blocks: [Block]) -> Bool {
        var current = parentIndex(of: index, in: blocks)
        while let parent = current {
            if blocks[parent].kind == "column" { return true }
            current = parentIndex(of: parent, in: blocks)
        }
        return false
    }

    /// The first addressable block inside the column list whose `id` prop is
    /// `listId`: where the caret goes after an insert, read back because the
    /// core mints the ids under the list.
    static func firstBlockId(inColumnList listId: String, in blocks: [Block]) -> String? {
        guard let index = blocks.firstIndex(where: { block in
            block.kind == "columnList" && block.props.contains { $0.name == "id" && $0.value == listId }
        }) else { return nil }
        let depth = blocks[index].depth
        return blocks[(index + 1)...]
            .prefix { $0.depth > depth }
            .first { $0.id != nil && !isStructural($0.kind) }?
            .id
    }

    // MARK: - Layout

    struct Column: Identifiable {
        /// The row offset of the `column` block, or of the first block when a
        /// malformed list holds blocks before any column.
        let id: Int
        let weight: Double
        let items: [Item]
    }

    struct Group: Identifiable {
        /// The row offset of the `columnList` block.
        let id: Int
        /// Indentation steps, relative to the enclosing column or the body.
        let indent: UInt32
        let columns: [Column]
    }

    enum Item: Identifiable {
        case row(NoteBlockList.Row)
        case columns(Group)

        var id: Int {
            switch self {
            case let .row(row): row.id
            case let .columns(group): group.id
            }
        }
    }

    /// The rows to draw, with every column list gathered into a group.
    ///
    /// A block's indentation inside a column counts from the column, not the
    /// body, so the column's own two levels are not drawn as nesting. A
    /// `column` row outside any column list draws nothing of its own; its
    /// blocks draw where they are. Nothing is dropped.
    static func layout(_ rows: [NoteBlockList.Row]) -> [Item] {
        layout(rows[...], base: 0)
    }

    private static func layout(_ rows: ArraySlice<NoteBlockList.Row>, base: UInt32) -> [Item] {
        var items: [Item] = []
        var index = rows.startIndex
        while index < rows.endIndex {
            let row = rows[index]
            let depth = row.block.depth
            if row.block.kind == "columnList" {
                let end = rows[(index + 1)...].firstIndex { $0.block.depth <= depth } ?? rows.endIndex
                items.append(.columns(Group(
                    id: row.id,
                    indent: steps(depth, from: base),
                    columns: columns(rows[(index + 1)..<end], listDepth: depth)
                )))
                index = end
                continue
            }
            if row.block.kind != "column" {
                var placed = row
                placed.indent = steps(depth, from: base)
                items.append(.row(placed))
            }
            index += 1
        }
        return items
    }

    private static func columns(_ rows: ArraySlice<NoteBlockList.Row>, listDepth: UInt32) -> [Column] {
        struct Open {
            let id: Int
            let weight: Double
            let from: Int
        }
        var columns: [Column] = []
        var start: Open?
        func close(at end: Int) {
            guard let open = start else { return }
            columns.append(Column(
                id: open.id, weight: open.weight,
                items: layout(rows[open.from..<end], base: listDepth + 2)
            ))
        }
        for index in rows.indices {
            let row = rows[index]
            if row.block.kind == "column", row.block.depth == listDepth + 1 {
                close(at: index)
                start = Open(id: row.id, weight: weight(of: row.block), from: index + 1)
            } else if start == nil {
                start = Open(id: row.id, weight: 1, from: index)
            }
        }
        close(at: rows.endIndex)
        return columns
    }

    private static func steps(_ depth: UInt32, from base: UInt32) -> UInt32 {
        depth > base ? depth - base : 0
    }
}

/// The rows and column groups of a body, in order.
struct NoteBlockItemsView: View {
    let items: [NoteColumns.Item]
    let row: (NoteBlockList.Row) -> NoteBlockView

    var body: some View {
        ForEach(items) { item in
            switch item {
            case let .row(blockRow):
                row(blockRow)
            case let .columns(group):
                NoteColumnsView(group: group, row: row)
            }
        }
    }
}

/// One column list.
///
/// Stacked on a compact width, column one's blocks then column two's, each
/// column marked by a quiet leading rule so the grouping survives the stack.
/// Side by side on a regular width, sized by each column's `width` weight as
/// desktop sizes them. No animation either way.
struct NoteColumnsView: View {
    let group: NoteColumns.Group
    let row: (NoteBlockList.Row) -> NoteBlockView

    @Environment(\.horizontalSizeClass) private var sizeClass

    var body: some View {
        content
            .padding(.leading, CGFloat(group.indent) * Tokens.Space.inset)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .contain)
            .accessibilityLabel("\(group.columns.count) columns")
    }

    @ViewBuilder
    private var content: some View {
        if sizeClass == .regular, group.columns.count > 1 {
            NoteColumnsLayout(weights: group.columns.map(\.weight), spacing: Tokens.Space.section) {
                columns
            }
        } else {
            VStack(alignment: .leading, spacing: Tokens.Space.medium) {
                columns
            }
        }
    }

    private var columns: some View {
        ForEach(Array(group.columns.enumerated()), id: \.element.id) { offset, column in
            VStack(alignment: .leading, spacing: Tokens.Space.medium) {
                NoteBlockItemsView(items: column.items, row: row)
            }
            .padding(.leading, Tokens.Space.medium)
            .frame(maxWidth: .infinity, alignment: .leading)
            .overlay(alignment: .leading) {
                Rectangle()
                    .fill(Tokens.Line.border.color)
                    .frame(width: 1)
                    .accessibilityHidden(true)
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Column \(offset + 1) of \(group.columns.count)")
        }
    }
}

/// Columns side by side, each given its `weight`'s share of the width left
/// after the gaps, as CSS `flex-grow` shares it on desktop.
///
/// Placed in the layout's own coordinate space, which SwiftUI mirrors for a
/// right-to-left layout, so the first column sits on the leading side.
struct NoteColumnsLayout: Layout {
    let weights: [Double]
    let spacing: CGFloat

    private func widths(for total: CGFloat, count: Int) -> [CGFloat] {
        let shares = (0..<count).map { $0 < weights.count ? weights[$0] : 1 }
        let sum = shares.reduce(0, +)
        let available = max(0, total - spacing * CGFloat(max(0, count - 1)))
        return shares.map { sum > 0 ? available * CGFloat($0 / sum) : available / CGFloat(count) }
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard !subviews.isEmpty else { return .zero }
        let total: CGFloat = if let width = proposal.width, width.isFinite {
            width
        } else {
            subviews.reduce(0) { $0 + $1.sizeThatFits(.unspecified).width }
                + spacing * CGFloat(subviews.count - 1)
        }
        let widths = widths(for: total, count: subviews.count)
        let height = zip(subviews, widths)
            .map { $0.sizeThatFits(ProposedViewSize(width: $1, height: nil)).height }
            .max() ?? 0
        return CGSize(width: total, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let widths = widths(for: bounds.width, count: subviews.count)
        var edge = bounds.minX
        for (subview, width) in zip(subviews, widths) {
            subview.place(
                at: CGPoint(x: edge, y: bounds.minY), anchor: .topLeading,
                proposal: ProposedViewSize(width: width, height: nil)
            )
            edge += width + spacing
        }
    }
}
