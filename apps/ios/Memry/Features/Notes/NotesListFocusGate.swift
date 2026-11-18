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
/// focus went to the list and were lost. While this gate is on screen, the
/// collection view's selection does not follow focus, so the mirror moves
/// nothing. The selection itself, its fill, and taps on rows are untouched.
///
/// Drawn behind the claimed note's row, so it sits inside the list's
/// collection view. It lets go when the claim ends and the row stops drawing
/// it, or when the row's cell leaves the screen.
struct NotesListFocusGate: UIViewRepresentable {
    func makeUIView(context: Context) -> Probe {
        let probe = Probe()
        probe.isUserInteractionEnabled = false
        return probe
    }

    func updateUIView(_ probe: Probe, context: Context) {}

    static func dismantleUIView(_ probe: Probe, coordinator: ()) {
        probe.hold(nil)
    }

    final class Probe: UIView {
        /// The list this probe holds.
        private weak var held: UICollectionView?

        /// The probes holding each list, with the list's own setting: a row's
        /// cell can be made again while the old one is still on screen.
        private final class Hold {
            var count = 0
            let followed: Bool

            init(followed: Bool) { self.followed = followed }
        }

        private static let holds = NSMapTable<UICollectionView, Hold>.weakToStrongObjects()

        override func didMoveToWindow() {
            super.didMoveToWindow()
            hold(window == nil ? nil : enclosingList())
        }

        func hold(_ list: UICollectionView?) {
            guard list !== held else { return }
            if let held, let hold = Self.holds.object(forKey: held) {
                hold.count -= 1
                if hold.count == 0 {
                    held.selectionFollowsFocus = hold.followed
                    Self.holds.removeObject(forKey: held)
                }
            }
            if let list {
                let hold = Self.holds.object(forKey: list) ?? Hold(followed: list.selectionFollowsFocus)
                hold.count += 1
                Self.holds.setObject(hold, forKey: list)
                list.selectionFollowsFocus = false
            }
            held = list
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
