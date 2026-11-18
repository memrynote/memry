import SwiftUI
import Testing

@testable import Memry

// #4832 (#4543 L2): the user's last explicit toggle decides the Notes
// columns. Note picks, the keyboard and the page sidebar keep it; a toggle of
// the columns, a Notes rail or the second note, or a rotation, replaces it.
// The split view's own writes, which follow its size changes, are no toggle
// (#5059). Time comes from fixed instants, never the wall clock.

private let closed = SideRailsOpen(dayPanel: false, journalDayPanel: true, inspector: false)
private let inspectorOpen = SideRailsOpen(dayPanel: false, journalDayPanel: true, inspector: true)
private let t0 = ContinuousClock.now
private func at(_ ms: Int) -> ContinuousClock.Instant { t0 + .milliseconds(ms) }

/// 13" landscape: the window, and the split view beside the page sidebar.
private let landscapeWindow = CGSize(width: 1366, height: 1024)
private let besidePageSidebar = CGSize(width: 1086, height: 972)
/// 13" portrait, without and with the software keyboard.
private let portraitWindow = CGSize(width: 1024, height: 1366)
private let portraitSplit = CGSize(width: 1024, height: 1314)
private let portraitSplitWithKeyboard = CGSize(width: 1024, height: 430)

/// 13" landscape beside the page sidebar, a note open beside the inspector,
/// the layout settled by `at(0)`.
private func besideTheRail() -> NotesColumns {
    var columns = NotesColumns()
    columns.windowResized(to: landscapeWindow, at: at(-2000))
    columns.splitViewResized(to: besidePageSidebar, at: at(-2000))
    columns.update(.init(noteBesideRail: true, rails: inspectorOpen))
    return columns
}

@Suite("#4832 notes columns")
struct NotesColumnsTests {
    @Test("the width picks the columns, and the note stands alone beside a rail")
    func widthAndRailsPick() {
        var columns = NotesColumns()
        columns.windowResized(to: landscapeWindow, at: at(0))
        columns.splitViewResized(to: CGSize(width: 1366, height: 1024), at: at(0))
        columns.update(.init(rails: closed))
        #expect(columns.shown == .all)
        #expect(columns.onScreen == .all)
        columns.splitViewResized(to: besidePageSidebar, at: at(10))
        #expect(columns.onScreen == .doubleColumn)
        #expect(besideTheRail().onScreen == .detailOnly)
    }

    @Test("a list brought back beside the rail stays through note picks and the page sidebar")
    func theUsersListStays() {
        var columns = besideTheRail()
        columns.splitViewWrote(.doubleColumn, at: at(0))
        // Another note picked, through no note open (a delete, a scope change).
        columns.update(.init(noteBesideRail: false, rails: inspectorOpen))
        columns.update(.init(noteBesideRail: true, rails: inspectorOpen))
        #expect(columns.shown == .doubleColumn)
        // The page sidebar hidden, then shown.
        columns.splitViewResized(to: CGSize(width: 1366, height: 1024), at: at(1000))
        columns.splitViewResized(to: besidePageSidebar, at: at(2000))
        #expect(columns.shown == .doubleColumn)
        #expect(!columns.needsPutBack)
    }

    @Test("a list hidden by the user stays hidden after the rail's room goes")
    func theUsersHiddenListStays() {
        var columns = NotesColumns()
        columns.windowResized(to: landscapeWindow, at: at(-2000))
        columns.splitViewResized(to: besidePageSidebar, at: at(-2000))
        columns.update(.init(rails: closed))
        columns.splitViewWrote(.detailOnly, at: at(0))
        columns.splitViewResized(to: CGSize(width: 1366, height: 1024), at: at(1000))
        #expect(columns.shown == .detailOnly)
    }

    @Test("a Notes rail toggle, the second note and a rotation hand the columns back")
    func newerTogglesWin() {
        var columns = besideTheRail()
        columns.splitViewWrote(.doubleColumn, at: at(0))
        columns.update(.init(rails: closed))
        #expect(columns.shown == .doubleColumn)
        columns.update(.init(noteBesideRail: true, rails: inspectorOpen))
        #expect(columns.shown == .detailOnly)

        columns.splitViewWrote(.doubleColumn, at: at(100))
        columns.update(.init(noteBesideRail: true, rails: inspectorOpen, splitShown: true))
        #expect(columns.shown == .detailOnly)

        // A rotation to portrait, where the rail has no room, and back.
        columns = besideTheRail()
        columns.splitViewWrote(.doubleColumn, at: at(0))
        columns.windowResized(to: portraitWindow, at: at(1000))
        columns.update(.init(rails: inspectorOpen))
        #expect(columns.shown == .doubleColumn)
        columns.windowResized(to: landscapeWindow, at: at(3000))
        columns.update(.init(noteBesideRail: true, rails: inspectorOpen))
        #expect(columns.shown == .detailOnly)
    }

    @Test("the keyboard shrinking the split view is no rotation, and a rotation under it is one")
    func theKeyboardIsNoRotation() {
        var columns = NotesColumns()
        columns.windowResized(to: portraitWindow, at: at(-2000))
        columns.splitViewResized(to: portraitSplit, at: at(-2000))
        columns.update(.init(rails: closed))
        columns.splitViewWrote(.all, at: at(0))
        // The caret goes into the body: the keyboard shows, then hides.
        columns.splitViewResized(to: portraitSplitWithKeyboard, at: at(1000))
        #expect(columns.shown == .all)
        columns.splitViewResized(to: portraitSplit, at: at(3000))
        #expect(columns.shown == .all)

        // The keyboard up through a rotation: the split view stays wider than
        // tall, the window turns.
        columns.splitViewResized(to: portraitSplitWithKeyboard, at: at(5000))
        columns.windowResized(to: landscapeWindow, at: at(7000))
        columns.splitViewResized(to: CGSize(width: 1086, height: 450), at: at(7000))
        #expect(columns.shown == .doubleColumn)
    }

    @Test("the split view's own writes after a resize are no choice")
    func theSplitViewsWritesAreNoChoice() {
        // Traced on 13" (#5059): back in landscape beside the rail with the
        // keyboard up, the split view writes columns shown before 30-230 ms
        // after its size last changed, and repeats the columns on screen
        // later still.
        var columns = besideTheRail()
        columns.splitViewResized(to: CGSize(width: 1086, height: 450), at: at(0))
        columns.splitViewWrote(.doubleColumn, at: at(138))
        #expect(columns.shown == .detailOnly)
        #expect(columns.needsPutBack)
        columns.putBack()
        #expect(columns.onScreen == .detailOnly)

        columns.splitViewWrote(.detailOnly, at: at(790))
        columns.splitViewWrote(.detailOnly, at: at(5000))
        columns.update(.init(noteBesideRail: false, rails: inspectorOpen))
        #expect(columns.shown == .doubleColumn, "a repeat of the columns on screen was taken as a choice")

        // Once the size has held, a change is the user's.
        columns.update(.init(noteBesideRail: true, rails: inspectorOpen))
        columns.splitViewWrote(.doubleColumn, at: at(6000))
        #expect(columns.shown == .doubleColumn)
        #expect(!columns.needsPutBack)
    }

    @Test("the Journal's Day Panel leaves the Notes columns alone")
    func theJournalsPanelIsNoNotesRail() {
        var columns = besideTheRail()
        columns.splitViewWrote(.doubleColumn, at: at(0))
        var rails = inspectorOpen
        rails.journalDayPanel.toggle()
        columns.update(.init(noteBesideRail: true, rails: rails))
        #expect(columns.shown == .doubleColumn)
        rails.dayPanel = true
        columns.update(.init(noteBesideRail: true, rails: rails))
        #expect(columns.shown == .detailOnly)
    }
}
