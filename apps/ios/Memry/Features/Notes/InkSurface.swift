import PencilKit
import SwiftUI

// The drawing surface (#4378): PencilKit over a whiteboard's canvas, opened by
// `/draw` and by a board holding only its ink. Full screen at regular width,
// a sheet at compact width. The board's other elements show under the ink,
// read only, and "Open full whiteboard" opens Excalidraw on the same canvas.

enum InkCopy {
    static let openFull = "Open full whiteboard"
    static let openFullHint = "Opens the board in the whiteboard editor, to edit shapes and text"
    static let saveFailedTitle = "Could not save the drawing"
    static let closeWithoutSaving = "Close without saving"
}

/// Presents a note's open whiteboard: the drawing surface or the full
/// editor, as the request says.
struct WhiteboardPresentation: ViewModifier {
    let session: EditorSession
    let boards: (any WhiteboardBoards)?

    @Environment(\.horizontalSizeClass) private var sizeClass

    func body(content: Content) -> some View {
        content
            .fullScreenCover(item: request { !$0.ink || sizeClass == .regular }) { request in
                surface(request)
            }
            .sheet(item: request { $0.ink && sizeClass != .regular }) { request in
                surface(request).presentationDetents([.large])
            }
    }

    private func request(when shown: @escaping (WhiteboardEditRequest) -> Bool) -> Binding<WhiteboardEditRequest?> {
        Binding(
            get: { boards == nil ? nil : session.whiteboardEdit.flatMap { shown($0) ? $0 : nil } },
            set: { if $0 == nil { session.finishWhiteboard() } }
        )
    }

    @ViewBuilder
    private func surface(_ request: WhiteboardEditRequest) -> some View {
        if let boards {
            if request.ink {
                InkSurface(request: request, boards: boards, requestSync: session.requestSync)
            } else {
                WhiteboardEditor(request: request, boards: boards)
            }
        }
    }
}

struct InkSurface: View {
    let request: WhiteboardEditRequest

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dismiss) private var dismiss
    @State private var board: InkBoard
    private let boards: any WhiteboardBoards
    @State private var full: WhiteboardEditRequest?

    init(request: WhiteboardEditRequest, boards: any WhiteboardBoards, requestSync: (@MainActor () -> Void)?) {
        self.request = request
        self.boards = boards
        let board = InkBoard(canvasId: request.canvasId, boards: boards)
        board.requestSync = requestSync
        _board = State(initialValue: board)
    }

    var body: some View {
        NavigationStack {
            content
                .navigationTitle(request.title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .primaryAction) {
                        Button(InkCopy.openFull, systemImage: "rectangle.on.rectangle.angled") {
                            Task { if await board.flush() { full = WhiteboardEditRequest(canvasId: request.canvasId, title: request.title) } }
                        }
                        .accessibilityHint(InkCopy.openFullHint)
                        .disabled(board.phase != .open || board.canvasLost)
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { Task { if await board.flush() { dismiss() } } }
                    }
                }
                .alert(
                    InkCopy.saveFailedTitle,
                    isPresented: Binding(get: { board.saveFailure != nil }, set: { if !$0 { board.saveFailure = nil } })
                ) {
                    // A deleted or unreadable canvas takes no save, so Done
                    // would fail forever: the drawing can only be left.
                    if board.canvasLost {
                        Button(InkCopy.closeWithoutSaving, role: .destructive) { dismiss() }
                    }
                    Button("OK", role: .cancel) { board.saveFailure = nil }
                } message: {
                    Text(board.saveFailure ?? "")
                }
        }
        .interactiveDismissDisabled()
        .task { await board.load() }
        // A size class change can swap the presentation under the surface;
        // what it has not saved yet still goes to the canvas.
        .onDisappear { Task { [board] in _ = await board.flush() } }
        .fullScreenCover(item: $full, onDismiss: { Task { await board.load() } }) { request in
            WhiteboardEditor(request: request, boards: boards)
        }
    }

    @ViewBuilder
    private var content: some View {
        switch board.phase {
        case .loading:
            ProgressView(WhiteboardCopy.loading).frame(maxWidth: .infinity, maxHeight: .infinity)
        case let .unavailable(message):
            Text(message)
                .font(Tokens.Typography.supporting.font)
                .foregroundStyle(Tokens.Text.secondary.color)
                .multilineTextAlignment(.center)
                .padding(Tokens.Space.screenInline)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .open:
            InkCanvas(board: board, dark: colorScheme == .dark, active: full == nil)
                .background(WhiteboardInk.color(board.backgroundColor, dark: colorScheme == .dark))
                .ignoresSafeArea(edges: .bottom)
                .accessibilityLabel("Drawing: \(request.title)")
        }
    }
}

/// Once a Pencil has drawn, a finger scrolls rather than draws, as in Notes.
/// Kept for the app's run.
@MainActor
enum InkInput {
    static var pencilSeen = false
}

struct InkCanvas: UIViewRepresentable {
    let board: InkBoard
    let dark: Bool
    /// `false` while the full whiteboard is open over the surface, which
    /// then hides the tool picker.
    let active: Bool

    func makeCoordinator() -> Coordinator { Coordinator(board: board) }

    /// Desktop has no pixel eraser, so the eraser always erases whole
    /// strokes. `InkStroke.visible` still saves a masked stroke as its
    /// visible parts.
    static func pinVectorEraser(_ tool: PKTool) -> PKTool {
        guard let eraser = tool as? PKEraserTool, eraser.eraserType != .vector else { return tool }
        return PKEraserTool(.vector)
    }

    /// The tools #4378 names. The eraser's popover still offers its pixel mode
    /// (no public API hides it). The picker restores that choice and the
    /// eraser item then reads as the pixel eraser, so the saved state stays
    /// off and the toolbar shows the object eraser the canvas uses.
    static func makeToolPicker() -> PKToolPicker {
        let picker = PKToolPicker(toolItems: [
            PKToolPickerInkingItem(type: .pen),
            PKToolPickerInkingItem(type: .marker),
            PKToolPickerEraserItem(type: .vector),
            PKToolPickerLassoItem(),
            PKToolPickerRulerItem(),
        ])
        picker.stateAutosaveName = nil
        return picker
    }

    func makeUIView(context: Context) -> InkCanvasView {
        let canvas = InkCanvasView()
        canvas.backgroundColor = .clear
        canvas.isOpaque = false
        canvas.minimumZoomScale = 1
        canvas.maximumZoomScale = 1
        canvas.alwaysBounceVertical = true
        canvas.drawingPolicy = InkInput.pencilSeen ? .pencilOnly : .anyInput
        canvas.delegate = context.coordinator
        let pencil = PencilSeen { [weak canvas] in
            InkInput.pencilSeen = true
            canvas?.drawingPolicy = .pencilOnly
        }
        canvas.addGestureRecognizer(pencil)
        let picker = context.coordinator.picker
        picker.colorUserInterfaceStyle = dark ? .dark : .light
        picker.setVisible(true, forFirstResponder: canvas)
        picker.addObserver(canvas)
        picker.addObserver(context.coordinator)
        context.coordinator.canvas = canvas
        context.coordinator.pinEraser()
        DispatchQueue.main.async { canvas.becomeFirstResponder() }
        return canvas
    }

    func updateUIView(_ canvas: InkCanvasView, context: Context) {
        let coordinator = context.coordinator
        if coordinator.loads != board.loads {
            coordinator.loads = board.loads
            coordinator.applying = true
            canvas.drawing = board.drawing
            coordinator.applying = false
        }
        let style: UIUserInterfaceStyle = dark ? .dark : .light
        if coordinator.picker.colorUserInterfaceStyle != style { coordinator.picker.colorUserInterfaceStyle = style }
        coordinator.underlay(in: canvas, scene: board.background, offset: board.offset, dark: dark)
        canvas.fitContent()
        if !active, canvas.isFirstResponder {
            canvas.resignFirstResponder()
        } else if active, !canvas.isFirstResponder, canvas.window != nil {
            canvas.becomeFirstResponder()
        }
    }

    @MainActor
    final class Coordinator: NSObject, PKCanvasViewDelegate, PKToolPickerObserver {
        let board: InkBoard
        let picker = InkCanvas.makeToolPicker()
        var loads = 0
        var applying = false
        weak var canvas: InkCanvasView?
        private var host: UIHostingController<WhiteboardCanvas>?
        private var drawn: (scene: WhiteboardScene?, dark: Bool)?

        init(board: InkBoard) { self.board = board }

        func canvasViewDrawingDidChange(_ canvas: PKCanvasView) {
            (canvas as? InkCanvasView)?.fitContent()
            guard !applying else { return }
            board.changed(canvas.drawing)
        }

        func toolPickerSelectedToolItemDidChange(_: PKToolPicker) { pinEraser() }
        func toolPickerVisibilityDidChange(_: PKToolPicker) { pinEraser() }

        /// The canvas observes the picker too and takes its tool in an order
        /// PencilKit does not set, so the pin runs after this notification.
        func pinEraser() {
            DispatchQueue.main.async { [weak self] in
                guard let canvas = self?.canvas else { return }
                canvas.tool = InkCanvas.pinVectorEraser(canvas.tool)
            }
        }

        /// The board's other elements, drawn once at scale 1 under the ink.
        func underlay(in canvas: InkCanvasView, scene: WhiteboardScene?, offset: CGPoint, dark: Bool) {
            guard drawn.map({ $0.scene != scene || $0.dark != dark }) ?? true else { return }
            drawn = (scene, dark)
            host?.view.removeFromSuperview()
            host = nil
            guard let scene, let bounds = scene.bounds else {
                canvas.backgroundBox = .null
                return
            }
            let box = bounds.insetBy(dx: -10, dy: -10)
            let host = UIHostingController(rootView: WhiteboardCanvas(scene: scene, box: box, scale: 1, dark: dark))
            host.view.backgroundColor = .clear
            host.view.isUserInteractionEnabled = false
            host.view.frame = box.offsetBy(dx: -offset.x, dy: -offset.y)
            canvas.insertSubview(host.view, at: 0)
            canvas.backgroundBox = host.view.frame
            self.host = host
        }
    }
}

/// PencilKit takes no stroke outside the content size. A size set before
/// the first layout covers only the loaded ink, so the canvas sizes its
/// content again once it knows its bounds.
final class InkCanvasView: PKCanvasView {
    var backgroundBox = CGRect.null
    private var fittedTo: CGSize?

    override func layoutSubviews() {
        super.layoutSubviews()
        if fittedTo != bounds.size { fitContent() }
    }

    /// Room to keep drawing past the ink and the background.
    func fitContent() {
        fittedTo = bounds.size
        let used = drawing.bounds.union(backgroundBox)
        let size = CGSize(
            width: max(bounds.width, used.isNull ? 0 : used.maxX + 40),
            height: max(bounds.height * 1.5, used.isNull ? 0 : used.maxY + bounds.height / 2)
        )
        if contentSize != size { contentSize = size }
    }
}

/// Sees a Pencil touch and never takes part in the gesture.
private final class PencilSeen: UIGestureRecognizer {
    private let seen: () -> Void

    init(_ seen: @escaping () -> Void) {
        self.seen = seen
        super.init(target: nil, action: nil)
        cancelsTouchesInView = false
        delaysTouchesBegan = false
        delaysTouchesEnded = false
    }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        if touches.contains(where: { $0.type == .pencil }) { seen() }
        state = .failed
    }
}
