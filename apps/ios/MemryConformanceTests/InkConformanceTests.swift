import Foundation
import MemryCore
import PencilKit
import Testing

@testable import Memry

// The drawing surface over the core's real canvas store (#4378), with the
// desktop board in `Fixtures/whiteboard.excalidraw`: what the surface saves
// is what the core stores and pushes, and what desktop then reads.

private final class InkFixtureMarker {}

@MainActor
@Suite("drawing surface over the core canvas store")
struct InkConformanceTests {
    private func desktopBoard() throws -> String {
        let url = try #require(Bundle(for: InkFixtureMarker.self).url(forResource: "whiteboard", withExtension: "excalidraw"))
        return try String(contentsOf: url, encoding: .utf8)
    }

    /// Each element's text as the stored scene holds it.
    private func rawElements(_ scene: String) throws -> [String] {
        let elements = try #require(try JSONSerialization.jsonObject(with: Data(scene.utf8)) as? [String: Any])["elements"] as? [Any]
        return try #require(elements).map { element in
            let data = (try? JSONSerialization.data(withJSONObject: element, options: [.sortedKeys])) ?? Data()
            return String(decoding: data, as: UTF8.self)
        }
    }

    @Test("ink saved over a desktop board keeps every desktop element, and a desktop edit survives the next save")
    func roundTripThroughTheCore() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("ink-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let vault = try Vault.open(vaultId: "conformance", directory: directory.path)
        let boards = CoreWhiteboardBoards(vault: vault, store: ConformanceKeychain(), executor: .shared)
        let canvas = try await boards.create(title: "Trip whiteboard", ownerNoteId: "n1")
        try await boards.save(canvas.id, scene: desktopBoard())
        let desktop = try #require(try await boards.board(canvas.id)).scene

        let board = InkBoard(canvasId: canvas.id, boards: boards)
        board.settleDelay = .seconds(3600)
        await board.load()
        #expect(board.phase == .open)
        #expect(board.drawing.strokes.isEmpty, "desktop's pen stroke is not the surface's ink")
        #expect(board.background?.elements.count == 8)

        // A stroke drawn on the canvas, as PencilKit hands it over.
        let points = [CGPoint(x: 60, y: 80), CGPoint(x: 90, y: 120)].map {
            PKStrokePoint(location: $0, timeOffset: 0, size: CGSize(width: 6, height: 6), opacity: 1, force: 1, azimuth: 0, altitude: .pi / 2)
        }
        let drawn = PKStroke(ink: PKInk(.pen, color: .black), path: PKStrokePath(controlPoints: points, creationDate: .now))
        board.changed(PKDrawing(strokes: [drawn]))
        #expect(await board.flush())

        let saved = try #require(try await boards.board(canvas.id)).scene
        let before = try rawElements(desktop), after = try rawElements(saved)
        #expect(Array(after.prefix(before.count)) == before, "desktop's elements come back unchanged, deleted one included")
        let head = #""elements":["#
        let desktopElements = try #require(desktop.range(of: head).flatMap { start in
            desktop.range(of: #"],"appState""#, range: start.upperBound ..< desktop.endIndex).map { desktop[start.upperBound ..< $0.lowerBound] }
        })
        #expect(saved.contains(head + desktopElements + ","), "and byte for byte, as the core stores them")
        let ink = try #require(InkScene.strokes(in: saved))
        #expect(ink.count == 1)
        #expect(ink.first?.ink.points.first == CGPoint(x: 60 + board.offset.x, y: 80 + board.offset.y))

        // Desktop adds a shape; the pull stores it while the surface is open.
        let shape = #"{"id":"desktop-rect","type":"rectangle","x":700,"y":10,"width":50,"height":40,"version":3,"isDeleted":false}"#
        let edited = saved.replacingOccurrences(of: #""elements":["#, with: #""elements":["# + shape + ",")
        try await boards.save(canvas.id, scene: edited)

        // Then the iPad erases its stroke.
        board.changed(PKDrawing())
        #expect(await board.flush())
        let final = try #require(try await boards.board(canvas.id)).scene
        let elements = try #require(try JSONSerialization.jsonObject(with: Data(final.utf8)) as? [String: Any])["elements"] as? [[String: Any]]
        let ids = try #require(elements).map { $0["id"] as? String }
        #expect(ids.first == "desktop-rect", "the desktop edit survived the iPad's save")
        let erased = try #require(elements?.first { $0["id"] as? String == ink.first?.id })
        #expect(erased["isDeleted"] as? Bool == true)
        #expect(erased["version"] as? Int == 2)
        #expect(try #require(InkScene.strokes(in: final)).isEmpty)
    }
}
