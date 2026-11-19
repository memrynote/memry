import SwiftUI
import UIKit

/// #5100: the notes list moves no keyboard focus to its selected row while a
/// new note's title claims the caret (`TitleFocusClaim`).
///
/// The split view's list is a `List(selection:)`, and its collection view's
/// selection follows focus, so each time SwiftUI mirrors the selection into
/// it (`selectItemAtIndexPath:`, when the row's cell is made and when the
/// list's contents update) UIKit moves the focus to the selected row. After
/// New note that happened up to six times in a row, about 200 ms apart. The
/// title took each move back, but the keys typed while the row held the
/// focus went to the list and were lost. While the hold is on, the
/// collection view's selection does not follow focus, so the mirror moves
/// nothing. The selection itself, its fill, and taps on rows are untouched.
///
/// Invariant: while the router's `titleClaim` is set, the list's
/// `selectionFollowsFocus` is false; at every other time it has the list's
/// own value. Only the router turns the hold on and off (`holding`), so no
/// cell decides it: a row made after the claim started, scrolled away, or
/// removed while held changes nothing, and the claim's end restores the list.
///
/// SwiftUI dependency: this assumes `List` is drawn by a `UICollectionView`
/// and that SwiftUI never writes its `selectionFollowsFocus`. Neither is API.
/// A debug build logs when the flag reads true while held, the sign that
/// SwiftUI wrote it and keys can be lost again.
@MainActor
final class NotesListFocusHold {
    /// Set by the router while a title claims the caret.
    var holding = false {
        didSet { if holding != oldValue { apply() } }
    }

    private weak var list: UICollectionView?
    /// The list's own setting, while held.
    private var followed: Bool?

    /// The split view's list, as a row of it found it.
    func attach(_ list: UICollectionView) {
        guard list !== self.list else { return check() }
        restore()
        self.list = list
        apply()
    }

    private func apply() {
        guard holding else { return restore() }
        guard let list else { return }
        check()
        if followed == nil { followed = list.selectionFollowsFocus }
        list.selectionFollowsFocus = false
    }

    private func restore() {
        guard let followed else { return }
        check()
        list?.selectionFollowsFocus = followed
        self.followed = nil
    }

    private func check() {
        #if DEBUG
        if followed != nil, list?.selectionFollowsFocus == true {
            Log.interface.debug("notes list: selectionFollowsFocus turned on while a title claim holds it")
        }
        #endif
    }
}

/// Drawn behind each note row of the split view's list, so it sits inside
/// the list's collection view, and hands that list to the router's hold.
/// Rows only find the list; whether it is held is the router's.
struct NotesListFocusGate: UIViewRepresentable {
    let hold: NotesListFocusHold

    func makeUIView(context: Context) -> Probe {
        let probe = Probe()
        probe.hold = hold
        probe.isUserInteractionEnabled = false
        return probe
    }

    func updateUIView(_ probe: Probe, context: Context) {
        probe.hold = hold
    }

    final class Probe: UIView {
        weak var hold: NotesListFocusHold?

        override func didMoveToWindow() {
            super.didMoveToWindow()
            guard window != nil, let list = enclosingList() else { return }
            hold?.attach(list)
        }

        private func enclosingList() -> UICollectionView? {
            var view = superview
            while let next = view {
                if let list = next as? UICollectionView { return list }
                view = next.superview
            }
            return nil
        }
    }
}
