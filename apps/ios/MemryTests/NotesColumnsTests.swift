import SwiftUI
import Testing

@testable import Memry

// #4832 (#4543 L2): the user's last explicit toggle decides the Notes
// columns. Note picks and the page sidebar keep it; a toggle of the columns,
// a rail or the second note, or a rotation, replaces it.

private let closed = SideRailsOpen(dayPanel: false, journalDayPanel: true, inspector: false)
private let inspectorOpen = SideRailsOpen(dayPanel: false, journalDayPanel: true, inspector: true)

/// 13" landscape beside the page sidebar, a note open beside the inspector.
private func besideTheRail() -> NotesColumns {
    var columns = NotesColumns()
    columns.update(.init(landscape: true, noteBesideRail: true, rails: inspectorOpen))
    return columns
}

@Suite("#4832 notes columns")
struct NotesColumnsTests {
    @Test("the width picks the columns, and the note stands alone beside a rail")
    func widthAndRailsPick() {
        var columns = NotesColumns()
        columns.update(.init(holdsThreeColumns: true, landscape: true, rails: closed))
        #expect(columns.shown == .all)
        columns.update(.init(landscape: true, rails: closed))
        #expect(columns.shown == .doubleColumn)
        #expect(besideTheRail().shown == .detailOnly)
    }

    @Test("a list brought back beside the rail stays through note picks and the page sidebar")
    func theUsersListStays() {
        var columns = besideTheRail()
        columns.choose(.doubleColumn)
        // Another note picked, through no note open (a delete, a scope change).
        columns.update(.init(landscape: true, noteBesideRail: false, rails: inspectorOpen))
        columns.update(.init(landscape: true, noteBesideRail: true, rails: inspectorOpen))
        #expect(columns.shown == .doubleColumn)
        // The page sidebar hidden, then shown.
        columns.update(.init(holdsThreeColumns: true, landscape: true, noteBesideRail: true, rails: inspectorOpen))
        columns.update(.init(landscape: true, noteBesideRail: true, rails: inspectorOpen))
        #expect(columns.shown == .doubleColumn)
    }

    @Test("a list hidden by the user stays hidden after the rail's room goes")
    func theUsersHiddenListStays() {
        var columns = NotesColumns()
        columns.update(.init(landscape: true, rails: closed))
        columns.choose(.detailOnly)
        columns.update(.init(holdsThreeColumns: true, landscape: true, rails: closed))
        #expect(columns.shown == .detailOnly)
    }

    @Test("a rail toggle, the second note and a rotation hand the columns back")
    func newerTogglesWin() {
        var columns = besideTheRail()
        columns.choose(.doubleColumn)
        columns.update(.init(landscape: true, rails: closed))
        #expect(columns.shown == .doubleColumn)
        columns.update(.init(landscape: true, noteBesideRail: true, rails: inspectorOpen))
        #expect(columns.shown == .detailOnly)

        columns.choose(.doubleColumn)
        columns.update(.init(landscape: true, noteBesideRail: true, rails: inspectorOpen, splitShown: true))
        #expect(columns.shown == .detailOnly)

        // A rotation to portrait, where the rail has no room, and back.
        columns = besideTheRail()
        columns.choose(.doubleColumn)
        columns.update(.init(landscape: false, rails: inspectorOpen))
        #expect(columns.shown == .doubleColumn)
        columns.update(.init(landscape: true, noteBesideRail: true, rails: inspectorOpen))
        #expect(columns.shown == .detailOnly)
    }
}
