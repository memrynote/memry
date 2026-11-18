import SwiftUI

/// Which columns the Notes split view shows (`DESIGN.md` › Tablet, #4832).
///
/// The width and the rails pick them: three columns at 13" landscape width,
/// two below it (Q4), and the note alone beside a rail or a second note (D9,
/// #4377). A column the user shows or hides with the split view's own button
/// overrides that, through note picks and the page sidebar sliding in or out,
/// until the user toggles again: the columns, a rail, or the second note. A
/// rotation hands the columns back to the width and the rails, as iPadOS does.
struct NotesColumns: Equatable {
    struct Inputs: Equatable {
        /// The split view's own width holds three columns.
        var holdsThreeColumns = false
        /// The window is wider than it is tall.
        var landscape = false
        /// A rail, or a second note, shows beside the open note.
        var noteBesideRail = false
        /// The rails' open states, as the user last toggled them.
        var rails: SideRailsOpen?
        /// The second note shows beside the first.
        var splitShown = false
    }

    private(set) var inputs = Inputs()
    private var chosen: NavigationSplitViewVisibility?

    var shown: NavigationSplitViewVisibility {
        if let chosen { return chosen }
        if inputs.noteBesideRail { return .detailOnly }
        return inputs.holdsThreeColumns ? .all : .doubleColumn
    }

    /// The user showed or hid a column with the split view's button.
    mutating func choose(_ columns: NavigationSplitViewVisibility) {
        chosen = columns
    }

    mutating func update(_ new: Inputs) {
        if new.landscape != inputs.landscape || new.rails != inputs.rails || new.splitShown != inputs.splitShown {
            chosen = nil
        }
        inputs = new
    }
}
