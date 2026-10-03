import MemryCore
import SwiftUI
import Testing

@testable import Memry

private func cell(aligned textAlignment: String?) -> TableCell {
    TableCell(
        blockId: nil,
        isHeader: false,
        colspan: 1,
        rowspan: 1,
        backgroundColor: nil,
        textColor: nil,
        textAlignment: textAlignment,
        colwidth: [nil],
        content: []
    )
}

@Suite("A table cell keeps its column's alignment")
struct NoteTableCellAlignmentTests {
    @Test(arguments: [
        ("center", TextAlignment.center),
        ("right", .trailing),
        ("left", .leading),
        ("justify", .leading),
    ])
    func desktopsTextAlignmentReadsAsSwiftUIs(_ prop: String, _ expected: TextAlignment) {
        #expect(NoteTableCellView.alignment(of: cell(aligned: prop)) == expected)
    }

    @Test func aCellWithNoAlignmentIsLeading() {
        #expect(NoteTableCellView.alignment(of: cell(aligned: nil)) == .leading)
    }
}
