import SwiftUI
import UIKit
import WebKit

// Desktop draws a math block with KaTeX and a diagram with mermaid. Neither
// has a native port, so this file keeps one WKWebView loaded with both
// (`Resources/BlockRender.bundle`) and turns source into pictures.
//
// **One web view, offscreen, batched.** A WKWebView costs a web content
// process and about a second to load cold, so the app keeps one and never
// shows it: it sits outside the window's bounds and is only snapshotted.
// Every source asked for in one layout pass is typeset in one call and
// captured in one snapshot that is then cropped, because a snapshot per
// formula costs about 35 ms each (20 formulas: 53 ms batched, 720 ms one
// by one).
//
// **Never on the note-open path.** Callers draw the source until the
// picture arrives, so a cold web view delays the picture, not the note.
// Pictures are cached in memory only: they are the note's plaintext as
// pixels, and the cache dies with the process instead of sitting on disk.

@MainActor
final class BlockWebRenderer: NSObject {
    static let shared = BlockWebRenderer()

    /// One picture to draw: the source and the ink and size it is drawn in.
    struct Request: Hashable, Sendable {
        let source: String
        /// A CSS colour.
        let ink: String
        /// The base font size in points.
        let size: Double
    }

    enum Output: Equatable {
        case image(UIImage)
        /// KaTeX refused the source, with its message.
        case invalid(String)
        /// No web view could be loaded. Not cached, so the next ask tries again.
        case unavailable
    }

    /// The web view's size, which bounds one batch's snapshot.
    private static let viewport = CGSize(width: 2048, height: 4096)
    private static let batchLimit = 24

    private let cache = NSCache<NSString, CachedOutput>()
    private var web: WKWebView?
    private var loaded: CheckedContinuation<Bool, Never>?
    private var waiting: [Request: [CheckedContinuation<Output, Never>]] = [:]
    private var queue: [Request] = []
    private var flushing = false

    private override init() {
        cache.countLimit = 300
        super.init()
        NotificationCenter.default.addObserver(
            self, selector: #selector(memoryWarning),
            name: UIApplication.didReceiveMemoryWarningNotification, object: nil
        )
    }

    /// The picture for `request` if one is already drawn.
    func cached(_ request: Request) -> Output? {
        cache.object(forKey: Self.key(request))?.output
    }

    func render(_ request: Request) async -> Output {
        if let hit = cached(request) { return hit }
        return await withCheckedContinuation { continuation in
            if waiting[request] == nil { queue.append(request) }
            waiting[request, default: []].append(continuation)
            flushSoon()
        }
    }

    private static func key(_ request: Request) -> NSString {
        "\(request.ink)|\(request.size)|\(request.source)" as NSString
    }

    private func flushSoon() {
        guard !flushing else { return }
        flushing = true
        Task { @MainActor in
            // Lets the rest of this layout pass queue its formulas first.
            await Task.yield()
            while !queue.isEmpty {
                let batch = Array(queue.prefix(Self.batchLimit))
                queue.removeFirst(batch.count)
                let outputs = await draw(batch)
                for (request, output) in zip(batch, outputs) {
                    guard let output else {
                        queue.insert(request, at: 0)
                        continue
                    }
                    if output != .unavailable { cache.setObject(CachedOutput(output), forKey: Self.key(request)) }
                    for continuation in waiting.removeValue(forKey: request) ?? [] {
                        continuation.resume(returning: output)
                    }
                }
            }
            flushing = false
        }
    }

    /// One output per request; `nil` for a picture that did not fit in this
    /// batch's snapshot, which is drawn again in a batch of its own.
    private func draw(_ batch: [Request]) async -> [Output?] {
        guard let web = await loadedWebView() else { return batch.map { _ in .unavailable } }
        let items = batch.map { ["source": $0.source, "ink": $0.ink, "size": $0.size] as [String: Any] }
        let answer = try? await web.callAsyncJavaScript(
            "return await renderMath(items)", arguments: ["items": items], in: nil, contentWorld: .page
        )
        guard let boxes = answer as? [[String: Any]], boxes.count == batch.count else {
            return batch.map { _ in .unavailable }
        }
        let rects = boxes.map(Self.rect)
        let alone = batch.count == 1
        let fitting = rects.compactMap { $0 }.filter { alone || $0.maxY <= Self.viewport.height }
        guard let union = fitting.reduce(nil, { ($0 ?? $1).union($1) }) else {
            return boxes.map { box in (box["error"] as? String).map(Output.invalid) }
        }
        let configuration = WKSnapshotConfiguration()
        configuration.rect = CGRect(x: 0, y: 0, width: union.maxX, height: union.maxY)
            .intersection(CGRect(origin: .zero, size: Self.viewport))
        configuration.afterScreenUpdates = true
        let snapshot = try? await web.takeSnapshot(configuration: configuration)
        return zip(boxes, rects).map { box, rect in
            if let error = box["error"] as? String { return .invalid(error) }
            guard let rect, alone || rect.maxY <= Self.viewport.height else { return nil }
            guard let snapshot, let image = Self.crop(snapshot, to: rect) else { return .unavailable }
            return .image(image)
        }
    }

    private static func rect(_ box: [String: Any]) -> CGRect? {
        guard let left = box["x"] as? Double, let top = box["y"] as? Double,
              let width = box["width"] as? Double, let height = box["height"] as? Double,
              width > 0, height > 0
        else { return nil }
        return CGRect(x: left, y: top, width: width, height: height)
    }

    private static func crop(_ snapshot: UIImage, to rect: CGRect) -> UIImage? {
        let scale = snapshot.scale
        let pixels = rect.applying(CGAffineTransform(scaleX: scale, y: scale)).integral
        guard let cropped = snapshot.cgImage?.cropping(to: pixels) else { return nil }
        return UIImage(cgImage: cropped, scale: scale, orientation: .up)
    }

    // MARK: The web view

    private func loadedWebView() async -> WKWebView? {
        if let web, web.window != nil { return web }
        web?.removeFromSuperview()
        web = nil
        guard let window = Self.window(),
              let base = Bundle.main.url(forResource: "BlockRender", withExtension: "bundle")
        else {
            Log.interface.error("block renderer has no window or bundle")
            return nil
        }
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let view = WKWebView(
            frame: CGRect(origin: CGPoint(x: -Self.viewport.width * 4, y: 0), size: Self.viewport),
            configuration: configuration
        )
        // Without this the page sits under the window's safe-area inset, and
        // every rect the page reports is off by it.
        view.scrollView.contentInsetAdjustmentBehavior = .never
        view.isOpaque = false
        view.backgroundColor = .clear
        view.scrollView.backgroundColor = .clear
        view.isUserInteractionEnabled = false
        view.accessibilityElementsHidden = true
        view.navigationDelegate = self
        window.insertSubview(view, at: 0)
        let ready = await withCheckedContinuation { continuation in
            loaded = continuation
            view.loadFileURL(base.appendingPathComponent("render.html"), allowingReadAccessTo: base)
        }
        guard ready else {
            view.removeFromSuperview()
            return nil
        }
        web = view
        return view
    }

    private static func window() -> UIWindow? {
        let windows = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
        return windows.first(where: \.isKeyWindow) ?? windows.first
    }

    private func finishLoading(_ ready: Bool) {
        loaded?.resume(returning: ready)
        loaded = nil
    }

    /// Drops the web view and its process. The next picture asked for loads
    /// a new one.
    @objc private func memoryWarning() {
        guard !flushing else { return }
        web?.removeFromSuperview()
        web = nil
    }
}

extension BlockWebRenderer: WKNavigationDelegate {
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        finishLoading(true)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        Log.interface.error("block renderer page failed")
        finishLoading(false)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        Log.interface.error("block renderer page failed")
        finishLoading(false)
    }

    /// Only the bundled page loads. KaTeX under `trust: false` emits no link,
    /// and this keeps it that way should one appear.
    func webView(
        _ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction
    ) async -> WKNavigationActionPolicy {
        navigationAction.request.url?.isFileURL == true ? .allow : .cancel
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.removeFromSuperview()
        if web === webView { web = nil }
    }
}

private final class CachedOutput {
    let output: BlockWebRenderer.Output
    init(_ output: BlockWebRenderer.Output) { self.output = output }
}
