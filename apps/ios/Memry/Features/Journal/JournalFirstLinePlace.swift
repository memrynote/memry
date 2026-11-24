import SwiftUI
import UIKit

/// Where a journal day's first line is drawn, read without redrawing the
/// field, to find the field's own text view as the app leaves (#4781).
@MainActor
final class JournalFirstLinePlace {
    private weak var view: UIView?

    /// The field's text view while it has the caret: the window's first
    /// responder, when it is the text view drawn where the field is. A block
    /// or another day's first line may hold the caret instead.
    var editing: UITextView? {
        guard let view, let window = view.window else { return nil }
        // A plain loop: a lazy `compactMap(...).first` maps each level again
        // for every level above it, which hung a deep page (#4776).
        func firstResponder(in view: UIView) -> UITextView? {
            if let text = view as? UITextView, text.isFirstResponder { return text }
            for subview in view.subviews {
                if let text = firstResponder(in: subview) { return text }
            }
            return nil
        }
        guard let text = firstResponder(in: window), !(text is BlockTextView),
              text.convert(text.bounds, to: window).intersects(view.convert(view.bounds, to: window))
        else { return nil }
        return text
    }

    /// Drawn behind the field, the same size.
    struct Reader: UIViewRepresentable {
        let place: JournalFirstLinePlace

        func makeUIView(context: Context) -> UIView {
            let view = UIView()
            view.isUserInteractionEnabled = false
            place.view = view
            return view
        }

        func updateUIView(_ view: UIView, context: Context) {
            place.view = view
        }
    }
}
