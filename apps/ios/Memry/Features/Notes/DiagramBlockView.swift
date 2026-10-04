import SwiftUI

// Desktop's diagram block (`@blocknote/diagram-block`): the block's plain
// content is Mermaid source, drawn as a picture, or "Add a diagram" when it
// is empty. Mermaid's message replaces a diagram it refuses; here the source
// stays in view, tinted, with the message under it, so the block never looks
// drawn when it is not.

struct DiagramBlockView: View {
    let source: String
    /// Opens the source sheet. `nil` on a read-only page.
    var edit: (() -> Void)?

    var body: some View {
        if let edit {
            Button(action: edit) { content }
                .buttonStyle(.plain)
                .accessibilityHint("Edits the Mermaid source")
        } else {
            content
        }
    }

    private var content: some View {
        DiagramPictureView(source: source)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Diagram")
            .accessibilityValue(source.isEmpty ? "Empty" : source)
    }
}

/// The diagram alone: the block's face, and the source sheet's preview.
struct DiagramPictureView: View {
    let source: String

    @Environment(\.colorScheme) private var colorScheme
    @State private var drawn: (request: BlockWebRenderer.Request, output: BlockWebRenderer.Output)?

    private var request: BlockWebRenderer.Request {
        .diagram(source, dark: colorScheme == .dark)
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
                guard !source.isEmpty, BlockWebRenderer.shared.cached(request) == nil else { return }
                let output = await BlockWebRenderer.shared.render(request)
                if !Task.isCancelled { drawn = (request, output) }
            }
    }

    @ViewBuilder
    private var face: some View {
        if source.isEmpty {
            Label("Add a diagram", systemImage: "point.3.connected.trianglepath.dotted")
                .font(Tokens.Typography.supporting.font)
                .foregroundStyle(Tokens.Text.secondary.color)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, Tokens.Space.small)
        } else {
            switch output {
            case let .image(image):
                ZoomableDiagram(image: image)
            case let .invalid(message):
                VStack(alignment: .leading, spacing: Tokens.Space.small) {
                    ScrollView(.horizontal, showsIndicators: false) {
                        Text(source)
                            .font(Tokens.Typography.recoveryMaterial.font)
                            .foregroundStyle(Tokens.Interaction.destructive.color)
                    }
                    Text(message)
                        .font(Tokens.Typography.technicalCaption.font)
                        .foregroundStyle(Tokens.Text.secondary.color)
                        .lineLimit(4)
                }
                .padding(Tokens.Space.inset)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Tokens.Canvas.surface.color, in: .rect(cornerRadius: Tokens.Radius.card))
            case .unavailable, nil:
                // The source until the picture is drawn, and for good when no
                // web view can be loaded.
                CodeRow(language: "mermaid", text: source)
            }
        }
    }
}

/// A diagram scaled down to the page's width, never up past its own size,
/// and pinched to zoom in. Letting go keeps the zoom; pinching in undoes it.
/// No double tap: it would delay the tap that opens the source sheet.
private struct ZoomableDiagram: View {
    let image: UIImage

    @State private var zoom: CGFloat = 1
    @GestureState private var pinch: CGFloat = 1

    private var scale: CGFloat { min(max(zoom * pinch, 1), 4) }

    var body: some View {
        Image(uiImage: image)
            .resizable()
            .scaledToFit()
            .frame(maxWidth: image.size.width)
            .scaleEffect(scale, anchor: .topLeading)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, Tokens.Space.small)
            .clipped()
            .gesture(
                MagnifyGesture()
                    .updating($pinch) { value, state, _ in state = value.magnification }
                    .onEnded { value in zoom = min(max(zoom * value.magnification, 1), 4) }
            )
    }
}
