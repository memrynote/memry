//
//  EditorToolbarColumn.swift
//  The keyboard toolbar keeps to the page's column. UIKit lays the keyboard
//  accessory across the whole window, and on an iPad the sidebar and the
//  notes list sit beside the page: the toolbar's strip ran over their rows
//  and took the taps meant for them.
//

import UIKit

/// The keyboard accessory: a window-wide strip holding the toolbar over the
/// page's column. A touch on the strip beside the toolbar falls through to
/// the sidebar or the list under it.
final class AccessoryStrip: UIView {
    private let toolbar: UIView
    private lazy var left = toolbar.leftAnchor.constraint(equalTo: leftAnchor)
    private lazy var right = rightAnchor.constraint(equalTo: toolbar.rightAnchor)

    init(toolbar: UIView) {
        self.toolbar = toolbar
        super.init(frame: .zero)
        backgroundColor = .clear
        translatesAutoresizingMaskIntoConstraints = false
        addSubview(toolbar)
        NSLayoutConstraint.activate([
            left, right,
            toolbar.topAnchor.constraint(equalTo: topAnchor),
            toolbar.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    /// The toolbar's size as last told to UIKit.
    private var told: CGSize?

    /// The toolbar's own size: UIKit re-sizes an accessory only when the
    /// accessory itself says its size changed, and the page's keyboard inset
    /// follows. The toolbar's size moves with its safe area (the home
    /// indicator's strip while the keys are away), which it says only to
    /// itself, so the strip passes each change on as the toolbar did when it
    /// was the accessory.
    override var intrinsicContentSize: CGSize {
        let size = toolbar.intrinsicContentSize
        told = size
        return size
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        if let told, told != toolbar.intrinsicContentSize { invalidateIntrinsicContentSize() }
    }

    override func safeAreaInsetsDidChange() {
        super.safeAreaInsetsDidChange()
        invalidateIntrinsicContentSize()
    }

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        let hit = super.hitTest(point, with: event)
        return hit === self ? nil : hit
    }

    /// Puts the toolbar over `column`, a span of the screen's x, or across
    /// the strip with none.
    func keep(to column: ClosedRange<CGFloat>?) {
        guard let screen = window?.screen else { return }
        let strip = convert(bounds, to: screen.coordinateSpace)
        let inset = column.map { (max(0, $0.lowerBound - strip.minX), max(0, strip.maxX - $0.upperBound)) } ?? (0, 0)
        guard left.constant != inset.0 || right.constant != inset.1 else { return }
        left.constant = inset.0
        right.constant = inset.1
    }
}

extension EditorSession {
    /// Moves the toolbar over the page holding the caret: as a block takes
    /// the caret, as the keys move, and as the focused block is laid out
    /// again, which a list shown or hidden beside the page does.
    func placeToolbar() {
        accessory.keep(to: pageColumn())
    }

    /// The page holding the caret, across the screen. `nil` with no caret,
    /// or no page around it. Inside its safe area: the page runs on under
    /// the sidebar and the list, which float over its edge.
    private func pageColumn() -> ClosedRange<CGFloat>? {
        guard let textView = field?.textView, textView.isFirstResponder, let screen = textView.window?.screen
        else { return nil }
        var ancestor = textView.superview
        while let view = ancestor, !Self.scrollsVertically(view) { ancestor = view.superview }
        guard let page = ancestor else { return nil }
        let insets = page.safeAreaInsets
        let visible = page.bounds.inset(by: UIEdgeInsets(top: 0, left: insets.left, bottom: 0, right: insets.right))
        let frame = page.convert(visible, to: screen.coordinateSpace)
        return frame.minX ... frame.maxX
    }

    private static func scrollsVertically(_ view: UIView) -> Bool {
        guard let scrollView = view as? UIScrollView else { return false }
        return scrollView.alwaysBounceVertical || scrollView.contentSize.height > scrollView.bounds.height
    }
}
