import SwiftUI

// The source of a block whose face is a picture: a math block's LaTeX or a
// diagram's Mermaid. Desktop edits it in a popover over the block
// (`math-block.tsx`, `@blocknote/diagram-block`) and writes it once, when the
// popover closes; this sheet does the same with Done, a monospaced field
// under a live preview.

/// A block whose source sheet is open.
struct BlockSourceRequest: Identifiable, Equatable {
    enum Kind: Equatable {
        /// The `latex` prop.
        case math
        /// The block's plain content.
        case diagram
    }

    let blockId: String
    /// The source as the block held it when the sheet opened.
    let source: String
    var kind: Kind = .math
    var id: String { blockId }
}

struct BlockSourceSheet: View {
    let request: BlockSourceRequest
    let save: (String) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var draft: String
    /// What the preview draws: the draft, a moment after typing stops.
    @State private var previewed: String
    @FocusState private var focused: Bool

    init(request: BlockSourceRequest, save: @escaping (String) -> Void) {
        self.request = request
        self.save = save
        _draft = State(initialValue: request.source)
        _previewed = State(initialValue: request.source)
    }

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: Tokens.Space.inset) {
                ScrollView {
                    preview
                        .frame(maxWidth: .infinity)
                }
                .frame(minHeight: Tokens.Size.minimumHitArea * 2)
                .background(Tokens.Canvas.surface.color, in: .rect(cornerRadius: Tokens.Radius.card))
                .accessibilityLabel("Preview")
                TextField(isDiagram ? "graph TD; A-->B" : "E = mc^2", text: $draft, axis: .vertical)
                    .font(Tokens.Typography.recoveryMaterial.font)
                    .lineLimit(3...12)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.asciiCapable)
                    .focused($focused)
                    .accessibilityLabel(isDiagram ? "Mermaid source" : "LaTeX source")
                Spacer(minLength: 0)
            }
            .padding(Tokens.Space.screenInline)
            .navigationTitle(isDiagram ? "Diagram" : "Equation")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { save(draft) }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .task(id: draft) {
            try? await Task.sleep(for: .milliseconds(150))
            if !Task.isCancelled { previewed = draft }
        }
        .onAppear { focused = true }
    }

    private var isDiagram: Bool { request.kind == .diagram }

    @ViewBuilder
    private var preview: some View {
        if isDiagram {
            DiagramPictureView(source: previewed)
        } else {
            MathFormulaView(latex: previewed)
        }
    }
}
