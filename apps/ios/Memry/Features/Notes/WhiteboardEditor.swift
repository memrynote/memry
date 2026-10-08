import MemryCore
import SwiftUI
import WebKit

// Desktop's canvas editor on iOS: Excalidraw itself, the copy desktop
// resolves (`Resources/Whiteboard.bundle`, built by
// `scripts/generate-whiteboard.mjs`), full screen over the note.
//
// The scene goes in as the stored bytes and comes back as Excalidraw's own
// `serializeAsJSON`, plus every top-level key desktop added that Excalidraw
// does not know (`memryAssets`). So a card's `customData`, a link, a frame or
// an externalized image survives an edit here unchanged. Each edit is saved
// 800 ms after it settles, as on desktop, and Done saves what is left.

struct WhiteboardEditRequest: Identifiable, Equatable {
    let canvasId: String
    let title: String
    var id: String { canvasId }
}

struct WhiteboardEditor: View {
    let request: WhiteboardEditRequest
    let boards: any WhiteboardBoards

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dismiss) private var dismiss
    @State private var phase: Phase = .loading
    @State private var page = WhiteboardPage()
    @State private var saveFailure: String?

    private enum Phase: Equatable {
        case loading
        case open
        case unavailable(String)
    }

    var body: some View {
        NavigationStack {
            ZStack {
                if case let .unavailable(message) = phase {
                    Text(message)
                        .font(Tokens.Typography.supporting.font)
                        .foregroundStyle(Tokens.Text.secondary.color)
                        .multilineTextAlignment(.center)
                        .padding(Tokens.Space.screenInline)
                } else {
                    WhiteboardWebView(page: page)
                        .ignoresSafeArea(edges: .bottom)
                        .accessibilityLabel("Drawing: \(request.title)")
                    if !page.ready {
                        ProgressView(WhiteboardCopy.loading)
                    }
                }
            }
            .navigationTitle(request.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { Task { await close() } }
                }
            }
            .alert(
                "Could not save the whiteboard",
                isPresented: Binding(get: { saveFailure != nil }, set: { if !$0 { saveFailure = nil } })
            ) {
                Button("OK", role: .cancel) { saveFailure = nil }
            } message: {
                Text(saveFailure ?? "")
            }
        }
        .interactiveDismissDisabled()
        .task { await open() }
    }

    private func open() async {
        do {
            guard let record = try await boards.board(request.canvasId) else {
                phase = .unavailable("\(WhiteboardCopy.missingTitle). \(WhiteboardCopy.missingBody)")
                return
            }
            // Desktop's `unreadable` rule: no editor over a scene it cannot
            // read, or its first save would replace the drawing with nothing.
            guard WhiteboardScene(json: record.scene) != nil else {
                phase = .unavailable("\(WhiteboardCopy.unreadableTitle). \(WhiteboardCopy.unreadableBody)")
                return
            }
            let canvasId = request.canvasId
            page.save = { [boards] scene in try await boards.save(canvasId, scene: scene) }
            page.saveFailed = { saveFailure = $0 }
            page.open(scene: record.scene, dark: colorScheme == .dark)
            phase = .open
        } catch {
            phase = .unavailable(WhiteboardCopy.loadFailed)
        }
    }

    private func close() async {
        if phase == .open, !(await page.flush()) { return }
        dismiss()
    }
}

/// The web page and its bridge.
@MainActor
@Observable
final class WhiteboardPage: NSObject {
    private(set) var ready = false
    @ObservationIgnored var save: (String) async throws -> Void = { _ in }
    @ObservationIgnored var saveFailed: (String) -> Void = { _ in }
    @ObservationIgnored private var pending: (scene: String, dark: Bool)?
    @ObservationIgnored private var loaded = false
    /// Saves run one at a time, in the order the page sent them.
    @ObservationIgnored private var saving: Task<Bool, Never>?

    @ObservationIgnored lazy var web: WKWebView = {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.userContentController.add(WeakMessageHandler(self), name: "board")
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = self
        view.scrollView.isScrollEnabled = false
        view.scrollView.contentInsetAdjustmentBehavior = .never
        if let base = Bundle.main.url(forResource: "Whiteboard", withExtension: "bundle") {
            view.loadFileURL(base.appendingPathComponent("editor.html"), allowingReadAccessTo: base)
        } else {
            Log.interface.error("whiteboard editor bundle is missing")
        }
        return view
    }()

    func open(scene: String, dark: Bool) {
        pending = (scene, dark)
        _ = web
        start()
    }

    private func start() {
        guard loaded, let pending else { return }
        self.pending = nil
        web.callAsyncJavaScript(
            "memryBoard.open(scene, dark)", arguments: ["scene": pending.scene, "dark": pending.dark],
            in: nil, in: .page
        ) { result in
            if case .failure = result { Log.interface.error("whiteboard editor did not open the scene") }
        }
    }

    /// Saves what the page has not saved yet. `false` when a save failed, so
    /// the editor stays open with the drawing on it.
    func flush() async -> Bool {
        guard ready else { return true }
        let scene = try? await web.callAsyncJavaScript("return memryBoard.flush()", contentWorld: .page) as? String
        if let scene { enqueue(scene) }
        return await saving?.value ?? true
    }

    private func enqueue(_ scene: String) {
        let previous = saving
        saving = Task { [weak self] in
            guard await previous?.value ?? true, let self else { return false }
            do {
                try await save(scene)
                return true
            } catch {
                Log.interface.error("whiteboard scene did not save")
                saveFailed(ErrorMapping.userFacing(error).guidance ?? WhiteboardCopy.saveFailed)
                return false
            }
        }
    }

    fileprivate func received(_ body: Any) {
        guard let message = body as? [String: Any] else { return }
        switch message["kind"] as? String {
        case "ready": ready = true
        case "scene": if let scene = message["scene"] as? String { enqueue(scene) }
        default: break
        }
    }
}

extension WhiteboardPage: WKNavigationDelegate {
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loaded = true
        start()
    }

    /// Only the bundled page and its own files load. Excalidraw's links and
    /// library browser would leave the board; the device stays offline-first.
    func webView(
        _ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction
    ) async -> WKNavigationActionPolicy {
        navigationAction.request.url?.isFileURL == true ? .allow : .cancel
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        Log.interface.error("whiteboard editor page ended")
        ready = false
    }
}

/// `WKUserContentController` holds its handlers strongly; this keeps the page
/// free to go when the editor closes.
private final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
    weak var page: WhiteboardPage?

    init(_ page: WhiteboardPage) { self.page = page }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        let body = message.body
        MainActor.assumeIsolated { page?.received(body) }
    }
}

private struct WhiteboardWebView: UIViewRepresentable {
    let page: WhiteboardPage

    func makeUIView(context: Context) -> WKWebView { page.web }
    func updateUIView(_ view: WKWebView, context: Context) {}
}
