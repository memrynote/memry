import Foundation
import MemryCore
import Synchronization
import Testing
import UIKit

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
            session.didChange = { done.resume() }
            session.saveSource("x^2")
        }
        #expect(editor.all == [.setProp(blockId: "m", name: "latex", value: "x^2")])
        #expect(session.sourceEdit == nil)
        #expect(session.history.popUndo()?.backward == .setProp(blockId: "m", name: "latex", value: ""))
    }

    @Test func doneWithTheSourceUnchangedWritesNothing() {
        let editor = RecordingSourceEditor()
        let model = NoteEditorViewModel(noteId: "n1", editor: editor)
        let session = model.session
        session.model = model
        session.editSource(BlockSourceRequest(blockId: "m", source: "x^2"))
        session.saveSource("x^2")
        #expect(session.sourceEdit == nil)
        #expect(!session.history.canUndo)
    }
}

/// The bundled page loads in the shared web view and KaTeX answers through
/// it: a picture for a formula, KaTeX's own message for a broken one.
@MainActor
struct BlockWebRendererTests {
    private func request(_ source: String) -> BlockWebRenderer.Request {
        BlockWebRenderer.Request(source: source, ink: "rgb(55, 53, 47)", size: 17)
    }

    @Test func aFormulaBecomesAPictureAndBrokenLatexItsMessage() async throws {
        async let fraction = BlockWebRenderer.shared.render(request("\\frac{a}{b}"))
        async let broken = BlockWebRenderer.shared.render(request("\\frac{a"))
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
        #expect(BlockWebRenderer.shared.cached(request("\\frac{a}{b}")) == .image(image))
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
