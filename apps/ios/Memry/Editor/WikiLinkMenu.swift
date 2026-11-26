//
//  WikiLinkMenu.swift
//  #4377: a wiki link's menu, after desktop's `wikiLinkMenu`: Open, and
//  Open to the Side.
//
//  A hold on a link, or a secondary click, shows it. Only where a pane can
//  show beside this note (`EditorSession.openWikiTargetToSide`): elsewhere a
//  hold on a link stays the text view's own, as before.
//

import UIKit

@MainActor
final class WikiLinkMenu: NSObject, UIGestureRecognizerDelegate, @preconcurrency UIEditMenuInteractionDelegate {
    private weak var field: BlockField?
    private var target: String?
    private var interaction: UIEditMenuInteraction?

    init(field: BlockField) {
        self.field = field
        super.init()
        let textView = field.textView
        let interaction = UIEditMenuInteraction(delegate: self)
        textView.addInteraction(interaction)
        self.interaction = interaction
        let hold = UILongPressGestureRecognizer(target: self, action: #selector(show(_:)))
        hold.delegate = self
        textView.addGestureRecognizer(hold)
        let click = UITapGestureRecognizer(target: self, action: #selector(show(_:)))
        click.buttonMaskRequired = .secondary
        click.delegate = self
        textView.addGestureRecognizer(click)
    }

    /// Only a touch on a link, where the link can open to the side.
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        guard let field, field.session?.openWikiTargetToSide != nil else { return false }
        return field.wikiTarget(at: touch.location(in: field.textView)) != nil
    }

    /// The text view's own hold (the caret's loupe, a selection) waits for
    /// this one on a link.
    func gestureRecognizer(
        _ gestureRecognizer: UIGestureRecognizer,
        shouldBeRequiredToFailBy otherGestureRecognizer: UIGestureRecognizer
    ) -> Bool {
        guard let textView = field?.textView, gestureRecognizer is UILongPressGestureRecognizer else { return false }
        return otherGestureRecognizer !== gestureRecognizer
            && !(otherGestureRecognizer is UITapGestureRecognizer)
            && otherGestureRecognizer.view?.isDescendant(of: textView) == true
    }

    @objc private func show(_ gesture: UIGestureRecognizer) {
        let fired: UIGestureRecognizer.State = gesture is UILongPressGestureRecognizer ? .began : .ended
        guard gesture.state == fired, let field, let interaction else { return }
        let point = gesture.location(in: field.textView)
        guard let target = field.wikiTarget(at: point) else { return }
        self.target = target
        interaction.presentEditMenu(with: UIEditMenuConfiguration(identifier: nil, sourcePoint: point))
    }

    func editMenuInteraction(
        _ interaction: UIEditMenuInteraction,
        menuFor configuration: UIEditMenuConfiguration,
        suggestedActions: [UIMenuElement]
    ) -> UIMenu? {
        guard let target, let session = field?.session else { return nil }
        return UIMenu(children: [
            UIAction(title: NotesPaneCopy.open, image: UIImage(systemName: "doc.text")) { _ in
                session.openWikiTarget?(target)
            },
            UIAction(title: NotesPaneCopy.openToTheSide, image: UIImage(systemName: "rectangle.split.2x1")) { _ in
                session.openWikiTargetToSide?(target)
            },
        ])
    }
}
