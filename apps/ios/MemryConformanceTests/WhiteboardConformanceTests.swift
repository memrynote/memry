import CoreGraphics
import Foundation
import Testing
import UIKit
import WebKit

@testable import Memry

// `Fixtures/whiteboard.excalidraw` holds what a desktop board carries: a
// frame, a card (`customData` and a note link), a hatched ellipse, a dashed
// diamond, an arrow, a pen stroke, text, an externalized image with its
// `memryAssets` sidecar, and a deleted shape. The bounds literals are what
// Excalidraw 0.18.1's own `getCommonBounds` returns for this file.

private final class FixtureMarker {}

private let fixture: String = {
    guard let url = Bundle(for: FixtureMarker.self).url(forResource: "whiteboard", withExtension: "excalidraw"),
          let text = try? String(contentsOf: url, encoding: .utf8)
    else { return "" }
    return text
}()

@Suite("whiteboard conformance")
struct WhiteboardConformanceTests {
    @Test("a desktop scene parses to its live elements and Excalidraw's bounds")
    func parsesTheFixture() throws {
        let scene = try #require(WhiteboardScene(json: fixture))
        #expect(scene.elements.count == 8)
        #expect(scene.elements.map(\.id) == ["frame-1", "card-1", "oval-1", "diamond-1", "arrow-1", "pen-1", "text-1", "image-1"])
        #expect(scene.bounds == CGRect(x: -40, y: -60, width: 640, height: 420))

        let unframed = scene.elements.filter { $0.kind != .frame }.map(\.bounds).reduce(CGRect.null) { $0.union($1) }
        #expect(unframed == CGRect(x: 0, y: 0, width: 580, height: 300))
        let strokes = scene.elements.filter { $0.kind == .arrow || $0.kind == .freedraw }.map(\.bounds).reduce(CGRect.null) { $0.union($1) }
        #expect(strokes == CGRect(x: 20, y: 60, width: 280, height: 200))

        let card = try #require(scene.elements.first { $0.id == "card-1" })
        #expect(card.fill == .solid("#ffec99"))
        #expect(card.rounded)
        #expect(scene.elements.first { $0.id == "oval-1" }?.fill == .hatched("#a5d8ff"))
        #expect(scene.elements.first { $0.id == "arrow-1" }?.endArrow == true)
        #expect(scene.elements.first { $0.id == "text-1" }?.text == "Ship the board")
        #expect(scene.inlineImages.isEmpty, "an externalized image has no bytes on this device")
    }

    @Test("a scene that is not an Excalidraw document is unreadable", arguments: [
        "not json", "[1, 2]", #"{"elements": {"a": 1}}"#, #"{"elements": "x"}"#,
    ])
    func unreadable(_ json: String) {
        #expect(WhiteboardScene(json: json) == nil)
    }

    @Test("an empty or element-less scene is an empty board", arguments: ["", " \n", #"{"type":"excalidraw"}"#])
    func emptyBoard(_ json: String) throws {
        let scene = try #require(WhiteboardScene(json: json))
        #expect(scene.elements.isEmpty)
        #expect(scene.bounds == nil)
    }

    @Test("Excalidraw's dark theme turns its black ink light and its white paper dark")
    func darkInk() throws {
        let ink = try #require(WhiteboardInk.rgba("#1e1e1e", dark: true))
        #expect(abs(ink.r - 0.8289) < 0.001 && abs(ink.g - 0.8289) < 0.001 && abs(ink.b - 0.8289) < 0.001)
        let paper = try #require(WhiteboardInk.rgba("#ffffff", dark: true))
        #expect(abs(paper.r - 0.07) < 0.001)
        #expect(WhiteboardInk.rgba("#1e1e1e", dark: false)?.r == 30.0 / 255)
        #expect(WhiteboardInk.rgba("transparent", dark: false) == nil)
        #expect(WhiteboardInk.rgba("#abc", dark: false)?.b == 0xCC / 255.0)
    }
}

@MainActor
@Suite("whiteboard editor round trip", .serialized)
struct WhiteboardRoundTripTests {
    @Test("Excalidraw's save keeps cards, links, frames, images and the asset sidecar")
    func keepsDesktopData() async throws {
        let page = WhiteboardPage()
        let window = try #require(UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }.flatMap(\.windows).first)
        page.web.frame = CGRect(x: -2000, y: 0, width: 390, height: 700)
        window.addSubview(page.web)
        defer { page.web.removeFromSuperview() }

        page.open(scene: fixture, dark: false)
        let deadline = Date.now.addingTimeInterval(20)
        while !page.ready, Date.now < deadline { try await Task.sleep(for: .milliseconds(50)) }
        try #require(page.ready, "the editor page did not open the scene")

        let saved = try #require(try await page.web.callAsyncJavaScript(
            "return memryBoard.serialize()", contentWorld: .page
        ) as? String)
        let out = try json(saved)
        let stored = try json(fixture)

        let elements = try #require(out["elements"] as? [[String: Any]])
        let byId = Dictionary(uniqueKeysWithValues: elements.compactMap { e in (e["id"] as? String).map { ($0, e) } })
        #expect(Set(byId.keys) == ["frame-1", "card-1", "oval-1", "diamond-1", "arrow-1", "pen-1", "text-1", "image-1"])
        #expect(byId["card-1"]?["customData"] as? [String: String] == ["entityType": "note", "entityId": "abc123"])
        #expect(byId["card-1"]?["link"] as? String == "memry://note/abc123")
        #expect(byId["oval-1"]?["frameId"] as? String == "frame-1")
        #expect(byId["frame-1"]?["name"] as? String == "Plan")
        #expect(byId["image-1"]?["fileId"] as? String == "file-1")
        #expect(byId["image-1"]?["status"] as? String == "saved")

        let files = try #require(out["files"] as? [String: [String: Any]])
        #expect(files["file-1"]?["dataURL"] as? String == "memry-file://local/attachments/canvas-assets/3f2a.png")
        #expect(NSArray(array: out["memryAssets"] as? [Any] ?? []) == NSArray(array: stored["memryAssets"] as? [Any] ?? []))

        #expect(try await page.web.callAsyncJavaScript("return memryBoard.flush()", contentWorld: .page) as? String == nil,
                "a board only looked at is not saved")
    }

    private func json(_ text: String) throws -> [String: Any] {
        try #require(try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])
    }
}
