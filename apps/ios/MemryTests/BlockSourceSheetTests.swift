import Foundation
import MemryCore
import Synchronization
import SwiftUI
import Testing
import UIKit
import WebKit

@testable import Memry

private final class RecordingSourceEditor: BlockEditing, @unchecked Sendable {
    let edits = Mutex<[BlockEdit]>([])
    func edit(noteId: String, _ edit: BlockEdit) async throws -> Bool {
        edits.withLock { $0.append(edit) }
        return true
    }
    var all: [BlockEdit] { edits.withLock { $0 } }
}

/// The math block's source sheet writes the typed LaTeX once, on Done, as
/// desktop's popover does when it closes.
@MainActor
struct BlockSourceSheetTests {
    @Test func doneWritesTheTypedSourceToTheLatexProp() async {
        let editor = RecordingSourceEditor()
        let model = NoteEditorViewModel(noteId: "n1", editor: editor)
        let session = model.session
        session.model = model
        session.editSource(BlockSourceRequest(blockId: "m", source: ""))
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            session.reload = { done.resume() }
            session.saveSource("x^2")
        }
        #expect(editor.all == [.setProp(blockId: "m", name: "latex", value: "x^2")])
        #expect(session.sourceEdit == nil)
        #expect(session.history.popUndo()?.backward == .setProp(blockId: "m", name: "latex", value: ""))
    }

    @Test func doneSchedulesASyncPassAfterTheWrite() async {
        let editor = RecordingSourceEditor()
        let model = NoteEditorViewModel(noteId: "n1", editor: editor)
        let session = model.session
        session.model = model
        var editsAtSync: [[BlockEdit]] = []
        session.requestSync = { editsAtSync.append(editor.all) }
        session.editSource(BlockSourceRequest(blockId: "m", source: ""))
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            session.reload = { done.resume() }
            session.saveSource("x^2")
        }
        #expect(editsAtSync == [[.setProp(blockId: "m", name: "latex", value: "x^2")]])
    }

    @Test func doneWritesADiagramsSourceAsItsPlainContent() async {
        let editor = RecordingSourceEditor()
        let model = NoteEditorViewModel(noteId: "n1", editor: editor)
        let session = model.session
        session.model = model
        session.editSource(BlockSourceRequest(blockId: "d", source: "graph TD; A-->B", kind: .diagram))
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            session.reload = { done.resume() }
            session.saveSource("graph TD; A-->C")
        }
        #expect(editor.all == [.replaceText(blockId: "d", text: "graph TD; A-->C", base: "graph TD; A-->B")])
        #expect(session.history.popUndo()?.backward == .replaceText(blockId: "d", text: "graph TD; A-->B", base: "graph TD; A-->C"))
    }

    @Test func doneWithTheSourceUnchangedWritesNothing() {
        let editor = RecordingSourceEditor()
        let model = NoteEditorViewModel(noteId: "n1", editor: editor)
        let session = model.session
        session.model = model
        var syncs = 0
        session.requestSync = { syncs += 1 }
        session.editSource(BlockSourceRequest(blockId: "m", source: "x^2"))
        session.saveSource("x^2")
        #expect(session.sourceEdit == nil)
        #expect(!session.history.canUndo)
        #expect(syncs == 0)
    }
}

extension KeyWindowSuites {
    /// #2672: Smart Punctuation turns a typed `--` into an em dash and `"` into
    /// a curly quote. Source text (a code block, the source sheet) turns it and
    /// autocorrect off; prose keeps the system's typing aids.
    @MainActor
    struct SourceTextInputTests {
        private func field(_ kind: String) -> BlockField {
            let model = NoteEditorViewModel(noteId: "n1", editor: RecordingSourceEditor())
            let block = Block(id: "b", kind: kind, depth: 0, props: [], inline: [InlineRun(text: "a --> b", marks: [], markAttrs: [:], target: nil)])
            let style = BlockText.Style(font: .systemFont(ofSize: 17), ink: .label, titleExists: nil)
            let field = BlockField(block: block, session: model.session, style: style, alignment: .natural)
            field.render()
            return field
        }

        private func isSource(_ view: UITextView) -> Bool {
            view.smartDashesType == .no && view.smartQuotesType == .no && view.smartInsertDeleteType == .no
                && view.autocorrectionType == .no && view.spellCheckingType == .no && view.autocapitalizationType == .none
        }

        @Test func aCodeBlockTypesSourceAndAParagraphProse() {
            #expect(isSource(field("codeBlock").textView))
            let prose = field("paragraph").textView
            #expect(prose.smartDashesType == .default && prose.smartQuotesType == .default && prose.autocorrectionType == .default)
        }

        @Test func aBlockTurnedIntoCodeTypesSource() {
            let field = field("paragraph")
            field.block = Block(id: "b", kind: "codeBlock", depth: 0, props: [], inline: field.block.inline)
            field.render()
            #expect(isSource(field.textView))
        }

        @Test func theSourceSheetFieldTypesSource() {
            var text = ""
            let source = SourceTextView(text: Binding(get: { text }, set: { text = $0 }), placeholder: "", label: "LaTeX source")
            let controller = UIHostingController(rootView: source)
            let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 320, height: 200))
            window.rootViewController = controller
            window.isHidden = false
            defer { window.isHidden = true }
            controller.view.layoutIfNeeded()
            let views = Self.textViews(in: controller.view)
            #expect(views.count == 1)
            #expect(views.allSatisfy(isSource))
        }

        private static func textViews(in view: UIView) -> [UITextView] {
            (view as? UITextView).map { [$0] } ?? view.subviews.flatMap(textViews)
        }
    }
}

/// Runs `body` against a renderer of its own, in a window that lives until
/// `body` returns. The shared renderer sits in whichever window was key when it
/// loaded, often another test's. When that test ended, its window went away
/// with the web view in it, WebKit suspended the web view, and a call into it
/// never returned (#5484).
@MainActor
private func withRenderer(_ body: (BlockWebRenderer) async throws -> Void) async throws {
    let scene = try #require(UIApplication.shared.connectedScenes.first as? UIWindowScene)
    let window = UIWindow(windowScene: scene)
    window.rootViewController = UIViewController()
    window.isHidden = false
    defer { window.isHidden = true }
    try await body(BlockWebRenderer { window })
}

extension KeyWindowSuites {
    /// The bundled page loads in the web view and KaTeX answers through it: a
    /// picture for a formula, KaTeX's own message for a broken one.
    @MainActor
    struct BlockWebRendererTests {
        private func request(_ source: String) -> BlockWebRenderer.Request {
            BlockWebRenderer.Request(source: source, ink: "rgb(55, 53, 47)", size: 17)
        }

        @Test func aFormulaBecomesAPictureAndBrokenLatexItsMessage() async throws {
            try await withRenderer { renderer in
                async let fraction = renderer.render(request("\\frac{a}{b}"))
                async let broken = renderer.render(request("\\frac{a"))
                guard case let .image(image) = await fraction else {
                    Issue.record("expected a picture, got \(await fraction)")
                    return
                }
                #expect(image.size.width > 10, "a fraction has width")
                #expect(image.size.height > image.size.width / 2, "and is about as tall as it is wide")
                #expect(inkedPixels(image) > 50, "the glyphs are painted, not a transparent box")
                guard case let .invalid(message) = await broken else {
                    Issue.record("expected KaTeX's message, got \(await broken)")
                    return
                }
                #expect(message.hasPrefix("KaTeX parse error"))
                #expect(renderer.cached(request("\\frac{a}{b}")) == .image(image))
            }
        }

        /// The app's renderer is built on whichever window is key, and that window
        /// can go away while a picture is drawn. A web view taken out of its window
        /// is suspended, so the picture, and every one queued behind it, never came.
        /// The first window holds its page's load, so it always goes away mid-load.
        @Test func theWindowGoingAwayMidPictureDoesNotHoldTheNextOne() async throws {
            let scene = try #require(UIApplication.shared.connectedScenes.first as? UIWindowScene)
            let load = HeldLoad()
            let first = LoadHoldingWindow(windowScene: scene, load: load)
            first.rootViewController = UIViewController()
            first.isHidden = false
            let next = UIWindow(windowScene: scene)
            next.rootViewController = UIViewController()
            next.isHidden = false
            defer { next.isHidden = true }
            let renderer = BlockWebRenderer { first.isHidden ? next : first }
            let firstPicture = FirstPicture()
            Task { firstPicture.output = await renderer.render(request("x^2")) }
            // The web view is in the first window, its page asked for and held.
            try await wait(30) { load.isHeld }
            // The window goes away. Hiding alone keeps it and its views alive,
            // so its views are taken out as its teardown would.
            first.isHidden = true
            first.subviews.forEach { $0.removeFromSuperview() }

            // Bounds only the failure: with the fix the picture ends as the web
            // view leaves, and the held load is let go so a failure unwinds.
            try await wait(30) { firstPicture.output != nil }
            load.release()
            try #require(firstPicture.output != nil, "the first picture ended when its window went away")
            guard case let .image(image) = await renderer.render(request("y^2")) else {
                Issue.record("expected a picture once the renderer moved to the next window")
                return
            }
            #expect(inkedPixels(image) > 20, "the glyphs are painted")
        }
    }
}

/// A window that holds the load of any web view put in it: the page's
/// navigation is never allowed, so it cannot finish before the window goes.
private final class LoadHoldingWindow: UIWindow {
    private let load: HeldLoad

    init(windowScene: UIWindowScene, load: HeldLoad) {
        self.load = load
        super.init(windowScene: windowScene)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("unused") }

    override func didAddSubview(_ subview: UIView) {
        super.didAddSubview(subview)
        guard let web = subview as? WKWebView else { return }
        load.renderer = web.navigationDelegate
        web.navigationDelegate = load
    }
}

@MainActor
private final class FirstPicture {
    var output: BlockWebRenderer.Output?
}

/// Stands between the web view and the renderer, holding the page's
/// navigation until `release` and passing the rest on.
@MainActor
private final class HeldLoad: NSObject, WKNavigationDelegate {
    weak var renderer: WKNavigationDelegate?
    private var held: [@MainActor (WKNavigationActionPolicy) -> Void] = []

    var isHeld: Bool { !held.isEmpty }

    func release() {
        let decisions = held
        held = []
        decisions.forEach { $0(.cancel) }
    }

    func webView(
        _ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void
    ) {
        held.append(decisionHandler)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        renderer?.webView?(webView, didFinish: navigation)
    }

    func webView(
        _ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error
    ) {
        renderer?.webView?(webView, didFailProvisionalNavigation: navigation, withError: error)
    }
}

/// A picture is cached by what changes it: a diagram by its source and
/// theme, never by the ink and size only a formula is drawn with.
struct BlockRenderCacheKeyTests {
    @Test func aDiagramsKeyFollowsItsSourceAndThemeOnly() {
        let flow = BlockWebRenderer.Request.diagram("graph TD; A-->B", dark: false)
        #expect(flow.cacheKey != BlockWebRenderer.Request.diagram("graph TD; A-->C", dark: false).cacheKey)
        #expect(flow.cacheKey != BlockWebRenderer.Request.diagram("graph TD; A-->B", dark: true).cacheKey)
        let inked = BlockWebRenderer.Request(
            source: "graph TD; A-->B", ink: "rgb(1, 2, 3)", size: 30, kind: .diagram, dark: false
        )
        #expect(inked.cacheKey == flow.cacheKey)
    }

    @Test func aDiagramAndAFormulaOfTheSameTextAreDifferentPictures() {
        let math = BlockWebRenderer.Request(source: "x", ink: "", size: 0)
        #expect(math.cacheKey != BlockWebRenderer.Request.diagram("x", dark: false).cacheKey)
    }
}

extension KeyWindowSuites {
    /// Mermaid answers through the same page: a picture for a flowchart, its
    /// message for broken source.
    @MainActor
    struct BlockWebRendererDiagramTests {
        @Test func aFlowchartBecomesAPictureAndBrokenMermaidItsMessage() async throws {
            try await withRenderer { renderer in
                async let flow = renderer.render(.diagram("graph TD; A-->B", dark: false))
                async let broken = renderer.render(.diagram("graph TD; A-->", dark: false))
                guard case let .image(image) = await flow else {
                    Issue.record("expected a picture, got \(await flow)")
                    return
                }
                #expect(image.size.height > 40, "two stacked nodes")
                #expect(inkedPixels(image) > 200, "the nodes are painted")
                guard case .invalid = await broken else {
                    Issue.record("expected mermaid's message, got \(await broken)")
                    return
                }
            }
        }

        @Test func aSixtyNodeGraphIsPaintedTopToBottom() async throws {
            try await withRenderer { renderer in
                let edges = (0..<59).map { "N\($0)-->N\($0 + 1)" }.joined(separator: "; ")
                let output = await renderer.render(.diagram("graph TD; " + edges, dark: false))
                guard case let .image(image) = output else {
                    Issue.record("expected a picture, got \(output)")
                    return
                }
                #expect(image.size.height > image.size.width, "a top-down chain is tall")
                #expect(inkedPixels(image) > 2000, "its nodes are painted, not a blank box")
            }
        }
    }
}

/// Pixels with any coverage: a picture taken before KaTeX's fonts loaded is
/// the right size and fully transparent.
private func inkedPixels(_ image: UIImage) -> Int {
    guard let cgImage = image.cgImage else { return 0 }
    let width = cgImage.width
    let height = cgImage.height
    var pixels = [UInt8](repeating: 0, count: width * height * 4)
    let drawn = pixels.withUnsafeMutableBytes { buffer in
        CGContext(
            data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ).map { context in
            context.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        } ?? false
    }
    guard drawn else { return 0 }
    return stride(from: 3, to: pixels.count, by: 4).filter { pixels[$0] > 0 }.count
}
