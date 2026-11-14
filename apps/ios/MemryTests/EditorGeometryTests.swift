//
//  EditorGeometryTests.swift
//  #4343. The note editor's geometry follows the width and height it gets,
//  not the size class: columns, page previews, the insert panel, and a
//  property's name.
//

import CoreGraphics
import Testing

@testable import Memry

@Suite("Editor geometry")
struct EditorGeometryTests {
    private let gap = Tokens.Space.section

    @Test func columns_sit_side_by_side_only_when_each_gets_its_minimum() {
        // A half-width 13" window is regular and about 330pt of text: three
        // columns there would be about 90pt each.
        #expect(NoteColumnsLayout.sideBySide([1, 1, 1], width: 330, spacing: gap) == nil)
        #expect(NoteColumnsLayout.sideBySide([1, 1], width: 330, spacing: gap) == nil)
        // A full 13" window's reading measure holds three.
        let three = NoteColumnsLayout.sideBySide([1, 1, 1], width: Tokens.Size.reading, spacing: gap)
        #expect(three == [224, 224, 224])
    }

    @Test func a_phone_stacks_its_columns() {
        #expect(NoteColumnsLayout.sideBySide([1, 1], width: 362, spacing: gap) == nil)
    }

    @Test func a_narrow_weighted_column_stacks_the_list() {
        // 0.25 of 696pt is 174pt, under the minimum, though an even split fits.
        #expect(NoteColumnsLayout.sideBySide([1, 1], width: Tokens.Size.reading, spacing: gap) != nil)
        #expect(NoteColumnsLayout.sideBySide([0.5, 1.5], width: Tokens.Size.reading, spacing: gap) == nil)
    }

    @Test func a_single_column_never_sits_beside_anything() {
        #expect(NoteColumnsLayout.sideBySide([1], width: 2000, spacing: gap) == nil)
    }

    @Test func a_page_preview_grows_with_its_width_up_to_the_reading_measure() {
        #expect(PreviewMeasure.height(forWidth: 362) == 420, "a phone keeps its 420pt")
        #expect(PreviewMeasure.height(forWidth: 600) == 600)
        #expect(PreviewMeasure.height(forWidth: 1200) == Tokens.Size.reading)
    }

    @Test func the_insert_panel_takes_at_most_forty_percent_of_the_window() {
        #expect(EditorPanelView.height(keyboard: 300, window: 500) == 200, "a short Stage Manager window")
        #expect(EditorPanelView.height(keyboard: 300, window: 1366) == 300, "a tall window keeps the keyboard's height")
        #expect(EditorPanelView.height(keyboard: 300, window: nil) == 300)
    }

    @Test func a_property_name_is_as_wide_as_its_text_with_a_minimum() {
        #expect(PropertyRowLayout.nameWidth(ideal: 40, widest: 40, row: 362) == 118)
        #expect(PropertyRowLayout.nameWidth(ideal: 170, widest: 170, row: 362) == 170, "half the row is the name's")
        #expect(PropertyRowLayout.nameWidth(ideal: 260, widest: 260, row: 720) == 260)
    }

    @Test func every_name_in_a_list_takes_the_widest_names_width() {
        // Short names share the minimum.
        #expect(PropertyRowLayout.nameWidth(ideal: 40, widest: 90, row: 362) == 118)
        #expect(PropertyRowLayout.nameWidth(ideal: 90, widest: 90, row: 362) == 118)
        // One longer name moves every value to its edge.
        #expect(PropertyRowLayout.nameWidth(ideal: 40, widest: 160, row: 362) == 160)
        #expect(PropertyRowLayout.nameWidth(ideal: 160, widest: 160, row: 362) == 160)
    }

    @Test func the_shared_width_stops_at_half_the_row() {
        // The widest name stacks; the rest share half the row.
        #expect(PropertyRowLayout.nameWidth(ideal: 300, widest: 300, row: 362) == nil)
        #expect(PropertyRowLayout.nameWidth(ideal: 40, widest: 300, row: 362) == 181)
        #expect(PropertyRowLayout.nameWidth(ideal: 170, widest: 300, row: 362) == 181)
    }

    @Test func a_name_too_wide_for_its_row_goes_above_the_value() {
        // A large Dynamic Type size on a phone.
        #expect(PropertyRowLayout.nameWidth(ideal: 300, widest: 300, row: 362) == nil)
        // A narrow row still gives every name its minimum.
        #expect(PropertyRowLayout.nameWidth(ideal: 100, widest: 100, row: 200) == 118)
    }

    @Test func a_row_offered_no_width_keeps_names_beside_their_values() {
        #expect(PropertyRowLayout.nameWidth(ideal: 40, widest: 600, row: nil) == 600)
        #expect(PropertyRowLayout.nameWidth(ideal: 600, widest: 40, row: nil) == 600)
    }
}
