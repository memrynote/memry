import SwiftUI
import UIKit

/// Which columns the Notes split view shows (`DESIGN.md` › Tablet, #4832).
///
/// The width and the rails pick them: three columns at 13" landscape width,
/// two below it (Q4), and the note alone beside a rail or a second note (D9,
/// #4377). A column the user shows or hides with the split view's own button
/// overrides that, through note picks, the keyboard and the page sidebar,
/// until the user toggles again: the columns, a Notes rail, or the second
/// note. A rotation hands the columns back to the width and the rails, as
/// iPadOS does.
///
/// **Whose write it is.** The split view reports the user's toggle and its
/// own relayouts through one binding, and exposes no hook that tells them
/// apart. Its own writes follow a change of its size (a rotation, the page
/// sidebar sliding, the software keyboard): traced 30-230 ms after the last
/// size change (#5059), they repeat the columns on screen or put back columns
/// shown before. So a write is the user's only when it changes the columns on
/// screen and the split view's size has held for `settle`. Any other write is
/// put back to `shown`.
///
/// **Rotation** is the window's shape, never the split view's: the keyboard
/// shrinks the split view (13" portrait: 1024×1314 to 1024×430) and leaves
/// the window alone. **Rails:** only those Notes shows reset the choice, the
/// inspector and the Day Panel off the Journal; the Journal's own panel never
/// does.
struct NotesColumns {
    /// 13" landscape is 1366-1376pt wide. Every smaller iPad in landscape
    /// (at most 1210pt), 13" portrait (1024-1032pt) and 13" landscape beside
    /// the page sidebar (about 1086pt) stay below it.
    static let threeColumnWidth: CGFloat = 1300
    static let settle: Duration = .milliseconds(500)

    struct Inputs: Equatable {
        /// A rail, or a second note, shows beside the open note.
        var noteBesideRail = false
        var inspectorOpen = false
        var dayPanelOpen = false
        /// The second note shows beside the first.
        var splitShown = false

        init(noteBesideRail: Bool = false, rails: SideRailsOpen? = nil, splitShown: Bool = false) {
            self.noteBesideRail = noteBesideRail
            inspectorOpen = rails?.inspector ?? false
            dayPanelOpen = rails?.dayPanel ?? false
            self.splitShown = splitShown
        }
    }

    private var inputs = Inputs()
    private var splitWidth: CGFloat = 0
    private var windowLandscape: Bool?
    private var resizedAt: ContinuousClock.Instant?
    private var chosen: NavigationSplitViewVisibility?
    /// The columns the split view shows, which its binding reads.
    private(set) var onScreen: NavigationSplitViewVisibility = .doubleColumn

    var shown: NavigationSplitViewVisibility {
        if let chosen { return chosen }
        if inputs.noteBesideRail { return .detailOnly }
        return splitWidth >= Self.threeColumnWidth ? .all : .doubleColumn
    }

    /// The split view wrote columns other than `shown`: put them back once
    /// it has taken its write.
    var needsPutBack: Bool { onScreen != shown }

    mutating func update(_ new: Inputs) {
        if new.inspectorOpen != inputs.inspectorOpen || new.dayPanelOpen != inputs.dayPanelOpen
            || new.splitShown != inputs.splitShown {
            chosen = nil
        }
        inputs = new
        onScreen = shown
    }

    mutating func splitViewResized(to size: CGSize, at now: ContinuousClock.Instant) {
        splitWidth = size.width
        resizedAt = now
        onScreen = shown
    }

    mutating func windowResized(to size: CGSize, at now: ContinuousClock.Instant) {
        let landscape = size.width > size.height
        if let windowLandscape, windowLandscape != landscape { chosen = nil }
        windowLandscape = landscape
        resizedAt = now
        onScreen = shown
    }

    mutating func splitViewWrote(_ columns: NavigationSplitViewVisibility, at now: ContinuousClock.Instant) {
        let settled = resizedAt.map { now - $0 >= Self.settle } ?? true
        if columns != onScreen, settled { chosen = columns }
        onScreen = columns
    }

    mutating func putBack() { onScreen = shown }
}

/// Reports the window's size, which the software keyboard leaves alone.
struct WindowSizeReader: UIViewRepresentable {
    let resized: (CGSize) -> Void

    func makeUIView(context: Context) -> ReaderView { ReaderView() }

    func updateUIView(_ view: ReaderView, context: Context) { view.resized = resized }

    final class ReaderView: UIView {
        var resized: ((CGSize) -> Void)?
        private var reported: CGSize?

        override func didMoveToWindow() {
            super.didMoveToWindow()
            report()
        }

        override func layoutSubviews() {
            super.layoutSubviews()
            report()
        }

        private func report() {
            guard let size = window?.bounds.size, size != reported else { return }
            reported = size
            // Out of the layout pass that called this, which may not change
            // SwiftUI state.
            DispatchQueue.main.async { [weak self] in self?.resized?(size) }
        }
    }
}
