import SwiftUI

// Desktop's math block (`math-block.tsx`): the `latex` prop typeset with
// KaTeX, centred, or "Add an equation" when it is empty. KaTeX's own message
// replaces a formula it refuses; here the source stays in view with the
// message under it, so the block never looks rendered when it is not.

struct MathBlockView: View {
    let latex: String
    /// Opens the source sheet. `nil` on a read-only page.
    var edit: (() -> Void)?

    var body: some View {
        if let edit {
            Button(action: edit) { content }
                .buttonStyle(.plain)
                .accessibilityHint("Edits the LaTeX source")
        } else {
            content
        }
    }

    private var content: some View {
        // Leading, as desktop draws it: its block's button shrinks to the
        // formula, so `justify-center` never moves it off the start.
        MathFormulaView(latex: latex)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Equation")
            .accessibilityValue(latex.isEmpty ? "Empty" : latex)
    }
}

/// The formula alone: the block's face, and the source sheet's preview.
struct MathFormulaView: View {
    let latex: String

    @Environment(\.colorScheme) private var colorScheme
    @ScaledMetric(relativeTo: .body) private var size: CGFloat = 17
    @State private var drawn: (request: BlockWebRenderer.Request, output: BlockWebRenderer.Output)?

    private var request: BlockWebRenderer.Request {
        let ink = Tokens.Text.primary.rgb(for: colorScheme == .dark ? .dark : .light)
        let css = "rgb(\(Int(ink.red * 255)), \(Int(ink.green * 255)), \(Int(ink.blue * 255)))"
        return BlockWebRenderer.Request(source: latex, ink: css, size: Double(size))
    }

    private var output: BlockWebRenderer.Output? {
        let request = request
        if let drawn, drawn.request == request { return drawn.output }
        return BlockWebRenderer.shared.cached(request)
    }

    var body: some View {
        face
            .task(id: request) {
                let request = request
                guard !latex.isEmpty, BlockWebRenderer.shared.cached(request) == nil else { return }
                let output = await BlockWebRenderer.shared.render(request)
                if !Task.isCancelled { drawn = (request, output) }
            }
    }

    @ViewBuilder
    private var face: some View {
        if latex.isEmpty {
            Label("Add an equation", systemImage: "sum")
                .font(Tokens.Typography.supporting.font)
                .foregroundStyle(Tokens.Text.secondary.color)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, Tokens.Space.small)
        } else {
            switch output {
            case let .image(image):
                ViewThatFits(in: .horizontal) {
                    formula(image)
                    // A formula wider than the page scrolls, as a wide code
                    // block does, rather than shrinking or clipping.
                    ScrollView(.horizontal, showsIndicators: false) { formula(image) }
                }
            case let .invalid(message):
                VStack(alignment: .leading, spacing: Tokens.Space.small) {
                    ScrollView(.horizontal, showsIndicators: false) {
                        Text(latex)
                            .font(Tokens.Typography.recoveryMaterial.font)
                            .foregroundStyle(Tokens.Interaction.destructive.color)
                    }
                    Text(message)
                        .font(Tokens.Typography.technicalCaption.font)
                        .foregroundStyle(Tokens.Text.secondary.color)
                }
                .padding(Tokens.Space.inset)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Tokens.Canvas.surface.color, in: .rect(cornerRadius: Tokens.Radius.card))
            case .unavailable, nil:
                // The source until the picture is drawn, and for good when no
                // web view can be loaded.
                CodeRow(language: "LaTeX", text: latex)
            }
        }
    }

    private func formula(_ image: UIImage) -> some View {
        Image(uiImage: image)
            .padding(.vertical, Tokens.Space.small)
    }
}
