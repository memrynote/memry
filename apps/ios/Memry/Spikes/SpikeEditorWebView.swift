import SwiftUI
import UIKit
import WebKit

/// R16's decision, spiked: subclass `WKWebView` and override the
/// `inputAccessoryView` getter. Public API since iOS 13, not a swizzle.
final class SpikeEditorWebView: WKWebView {
    /// Cached, as R16 requires: a new instance per getter call makes the bar
    /// flicker on every keyboard transition.
    private var cachedAccessory: UIInputView?
    private var hostingController: UIHostingController<SpikeKeyboardToolbar>?

    /// Returning `nil` here is what hides WebKit's own bar.
    var showsMemryToolbar = true

    override var inputAccessoryView: UIView? {
        guard showsMemryToolbar else { return nil }
        if let cachedAccessory { return cachedAccessory }

        let toolbar = SpikeKeyboardToolbar()
        let controller = UIHostingController(rootView: toolbar)
        controller.view.backgroundColor = .clear

        let accessory = UIInputView(
            frame: CGRect(x: 0, y: 0, width: bounds.width, height: 52),
            inputViewStyle: .keyboard
        )
        accessory.allowsSelfSizing = true
        accessory.translatesAutoresizingMaskIntoConstraints = true
        accessory.autoresizingMask = [.flexibleWidth]
        controller.view.frame = accessory.bounds
        controller.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        accessory.addSubview(controller.view)

        hostingController = controller
        cachedAccessory = accessory
        return accessory
    }
}

/// The SwiftUI toolbar the accessory view hosts. Deliberately shows the live
/// Reduce Transparency value: a screenshot that does not say which mode it was
/// taken in is not evidence for research §E.
struct SpikeKeyboardToolbar: View {
    private let reduceTransparency = UIAccessibility.isReduceTransparencyEnabled

    var body: some View {
        HStack(spacing: 12) {
            ForEach(["bold", "italic", "list.bullet", "link"], id: \.self) { symbol in
                Image(systemName: symbol)
                    .font(.system(size: 17, weight: .medium))
                    .frame(width: 40, height: 36)
                    .glassEffect(.regular.interactive(), in: .rect(cornerRadius: 10))
            }
            Spacer(minLength: 8)
            Text(reduceTransparency ? "RT ON" : "RT OFF")
                .font(.caption.monospaced().bold())
                .accessibilityIdentifier("spike-reduce-transparency")
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .glassEffect(.regular, in: .capsule)
        }
        .padding(.horizontal, 12)
        .frame(maxWidth: .infinity, minHeight: 52)
    }
}
