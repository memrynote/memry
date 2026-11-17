import CoreGraphics
import Foundation
import PencilKit
import Testing

@testable import Memry

private func pinned() -> InkStamp {
    var next = 0
    var ids = 0
    return InkStamp(
        now: { 1_700_000_000_000 },
        random: { next += 1; return next },
        newId: { ids += 1; return "ink-\(ids)" }
    )
}

private let pen = InkStroke(
    points: [CGPoint(x: 10.37, y: 20.5), CGPoint(x: 30.11, y: 41.25), CGPoint(x: 55, y: 18.03)],
    pressures: [0.25, 0.5, 0.875],
    color: "#e03131",
    width: 0.75,
    opacity: 100,
    inkType: PKInk.InkType.pen.rawValue
)

private func object(_ text: String) throws -> [String: Any] {
    try #require(JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])
}

private func elements(_ scene: String) throws -> [[String: Any]] {
    try #require(try object(scene)["elements"] as? [[String: Any]])
}

/// A desktop shape written the way no serializer here writes it: spaced,
/// keys unsorted, `1.0`, an escaped character.
private let foreignRect = ##"{ "type" : "rectangle", "id":"rect-1", "x": 1.0, "y":-2, "width":40, "height":30, "strokeColor":"#1971c2", "text":"caf\u00e9", "version": 7, "isDeleted":false }"##

private func scene(_ elements: [String]) -> String {
    ##"{"type":"excalidraw","version":2,"source":"https://excalidraw.com","elements":[\##(elements.joined(separator: ",\n  "))],"appState":{"viewBackgroundColor":"#fff"},"files":{}}"##
}

@Suite("drawing ink and Excalidraw freedraw")
struct InkSceneTests {
    @Test("a stroke written as freedraw reads back the same: points, pressure, colour, width")
    func freedrawRoundTrip() throws {
        let marker = InkStroke(
            points: [CGPoint(x: -5, y: 3.5), CGPoint(x: 8.25, y: 3.5)], pressures: [0.5, 0.5],
            color: "#ffd43b", width: 2.5, opacity: 40, inkType: PKInk.InkType.marker.rawValue
        )
        let written = try #require(InkScene.apply(InkEdit(added: [pen, marker]), to: "", stamp: pinned()))
        #expect(written.addedIds == ["ink-1", "ink-2"])
        let read = try #require(InkScene.strokes(in: written.scene))
        #expect(read.map(\.id) == ["ink-1", "ink-2"])
        #expect(read.map(\.ink) == [pen, marker])

        let element = try #require(try elements(written.scene).first)
        #expect(element["type"] as? String == "freedraw")
        #expect(element["x"] as? Double == 10.37)
        #expect(element["y"] as? Double == 20.5)
        let points = try #require(element["points"] as? [[Double]])
        #expect(points.first == [0, 0], "points are relative to the element's origin")
        #expect(points.last == [44.63, -2.47])
        #expect(element["pressures"] as? [Double] == [0.25, 0.5, 0.875])
        #expect(element["simulatePressure"] as? Bool == false)
        #expect(element["strokeColor"] as? String == "#e03131")
        #expect(element["strokeWidth"] as? Double == 0.75)
        #expect(element["width"] as? Double == 44.63)
        #expect(element["version"] as? Int == 1)
        #expect(element["isDeleted"] as? Bool == false)
        let custom = try #require(element["customData"] as? [String: Any])
        #expect(custom["memryInk"] as? Bool == true)
        // The app still reads the scene, and the preview sees the ink.
        let picture = try #require(WhiteboardScene(json: written.scene))
        #expect(picture.elements.map(\.memryInk) == [true, true])
        #expect(picture.opensAsInk)
    }

    @Test("a PencilKit stroke and its freedraw convert both ways")
    func pencilKitRoundTrip() {
        let offset = CGPoint(x: -40, y: 12)
        let stroke = pen.stroke(created: InkLedger.created(index: 0), offset: offset)
        // PencilKit keeps points as 32-bit floats; the 0.01 rounding absorbs it.
        let first = stroke.path.first?.location ?? .zero
        #expect(abs(first.x - 50.37) < 0.001 && abs(first.y - 8.5) < 0.001, "canvas point = scene point - offset")
        #expect(stroke.path.first?.force == 0.5)
        #expect(stroke.path.first?.size.width == 4.5)
        #expect(InkStroke(stroke, offset: offset) == pen)

        let marker = InkStroke(
            points: [CGPoint(x: 0, y: 0), CGPoint(x: 4, y: 4)], pressures: [0.5, 0.5],
            color: "#1e1e1e", width: 3, opacity: 50, inkType: PKInk.InkType.marker.rawValue
        )
        #expect(InkStroke(marker.stroke(created: .now, offset: .zero), offset: .zero) == marker)
    }

    @Test("a finger stroke with no force reading rests at Excalidraw's 0.5, and a lasso move lands in the points")
    func fingerAndTransform() {
        let points = [CGPoint(x: 0, y: 0), CGPoint(x: 10, y: 0)].map {
            PKStrokePoint(location: $0, timeOffset: 0, size: CGSize(width: 3, height: 3), opacity: 1, force: 0, azimuth: 0, altitude: .pi / 2)
        }
        let ink = PKInk(.pen, color: UIColor(red: 0, green: 0, blue: 0, alpha: 1))
        let stroke = PKStroke(ink: ink, path: PKStrokePath(controlPoints: points, creationDate: .now), transform: CGAffineTransform(translationX: 5, y: 7))
        let read = InkStroke(stroke, offset: CGPoint(x: 100, y: 0))
        #expect(read.pressures == [0.5, 0.5])
        #expect(read.points == [CGPoint(x: 105, y: 7), CGPoint(x: 115, y: 7)])
        #expect(read.width == 0.5)
        #expect(read.color == "#000000")
        #expect(read.opacity == 100)
    }

    @Test("an edit keeps every other element's bytes and the text around the array")
    func foreignElementsUntouched() throws {
        let start = try #require(InkScene.apply(InkEdit(added: [pen]), to: scene([foreignRect]), stamp: pinned()))
        #expect(start.scene.contains(foreignRect))
        var moved = pen
        moved.points = moved.points.map { CGPoint(x: $0.x + 1, y: $0.y) }
        let edited = try #require(InkScene.apply(InkEdit(changed: ["ink-1": moved]), to: start.scene, stamp: pinned()))
        #expect(edited.scene.hasPrefix(##"{"type":"excalidraw","version":2,"source":"https://excalidraw.com","elements":["## + foreignRect + ","))
        #expect(edited.scene.hasSuffix(##"],"appState":{"viewBackgroundColor":"#fff"},"files":{}}"##))
        #expect(try #require(InkScene.strokes(in: edited.scene)).map(\.ink) == [moved])
        let ink = try #require(try elements(edited.scene).last)
        #expect(ink["version"] as? Int == 2)
        // A desktop freedraw without the flag is not the surface's ink.
        let desktopPen = ##"{"type":"freedraw","id":"pen-1","x":0,"y":0,"points":[[0,0],[5,5]],"customData":{"cardId":"x"}}"##
        #expect(try #require(InkScene.strokes(in: scene([desktopPen]))).isEmpty)
    }

    @Test("an erase is Excalidraw's delete: isDeleted and a version bump")
    func eraseMarksDeleted() throws {
        let start = try #require(InkScene.apply(InkEdit(added: [pen]), to: scene([foreignRect]), stamp: pinned()))
        let erased = try #require(InkScene.apply(InkEdit(erased: ["ink-1"]), to: start.scene, stamp: pinned()))
        #expect(erased.scene.contains(foreignRect))
        let element = try #require(try elements(erased.scene).last)
        #expect(element["id"] as? String == "ink-1")
        #expect(element["isDeleted"] as? Bool == true)
        #expect(element["version"] as? Int == 2)
        #expect(element["versionNonce"] as? Int == 1)
        #expect(try #require(InkScene.strokes(in: erased.scene)).isEmpty)
        #expect(WhiteboardScene(json: erased.scene)?.elements.map(\.id) == ["rect-1"])
        // Erasing what desktop already deleted leaves it as it is.
        let again = try #require(InkScene.apply(InkEdit(erased: ["ink-1"]), to: erased.scene, stamp: pinned()))
        #expect(again.scene == erased.scene)
    }

    @Test("an edit lands on the scene as stored now, so a desktop edit made meanwhile stays")
    func editAppliesToTheStoredScene() throws {
        let opened = try #require(InkScene.apply(InkEdit(added: [pen]), to: scene([]), stamp: pinned()))
        // Desktop adds a shape and the pull stores it while the surface is open.
        let stored = opened.scene.replacingOccurrences(of: ##""elements":["##, with: ##""elements":["## + foreignRect + ",")
        var stamp = pinned()
        stamp.newId = { "ink-2" }
        let saved = try #require(InkScene.apply(InkEdit(added: [pen], erased: ["ink-1"]), to: stored, stamp: stamp))
        #expect(saved.scene.contains(foreignRect))
        #expect(try elements(saved.scene).map { $0["id"] as? String } == ["rect-1", "ink-1", "ink-2"])
        #expect(try elements(saved.scene).map { $0["isDeleted"] as? Bool } == [false, true, false])
    }

    @Test("a scene that is not Excalidraw JSON is never written over; one with no array gets one")
    func unreadableAndMissingArray() throws {
        #expect(InkScene.apply(InkEdit(added: [pen]), to: "not json", stamp: pinned()) == nil)
        #expect(InkScene.strokes(in: "[1,2]") == nil)
        let added = try #require(InkScene.apply(InkEdit(added: [pen]), to: ##"{"type":"excalidraw","files":{}}"##, stamp: pinned()))
        #expect(added.scene.hasSuffix(##","type":"excalidraw","files":{}}"##))
        #expect(try #require(InkScene.strokes(in: added.scene)).count == 1)
    }

    @Test("an own element desktop rotated reads back with the rotation in its points")
    func rotatedElement() throws {
        let rotated = ##"{"type":"freedraw","id":"r","x":0,"y":0,"angle":3.141592653589793,"points":[[0,0],[10,0]],"pressures":[0.5,0.5],"customData":{"memryInk":true}}"##
        let ink = try #require(InkScene.strokes(in: scene([rotated]))?.first?.ink)
        #expect(ink.points == [CGPoint(x: 10, y: 0), CGPoint(x: 0, y: 0)])
        #expect(ink.inkType == InkScene.defaultInk)
    }

    @Test("the ledger tells added, changed and erased strokes apart, and a lasso copy is new")
    func ledgerDiff() {
        var moved = pen
        moved.width = 2
        var ledger = InkLedger([
            .init(created: 1, id: "a", ink: pen),
            .init(created: 2, id: "b", ink: pen),
            .init(created: 3, id: "c", ink: pen),
        ])
        let strokes: [(created: Double, ink: InkStroke)] = [(1, pen), (2, moved), (2, moved), (99, pen)]
        let (edit, ids) = ledger.diff(strokes)
        #expect(edit.changed == ["b": moved])
        #expect(edit.erased == ["c"])
        #expect(edit.added == [moved, pen])
        #expect(ids == ["a", "b", nil, nil])
        ledger.commit(strokes, ids: ids, addedIds: ["n1", "n2"])
        #expect(ledger.entries.map(\.id) == ["a", "b", "n1", "n2"])
        #expect(ledger.diff(strokes).edit.isEmpty)
    }

    @Test("an empty board or one with the surface's ink opens in the surface; a desktop-only board does not")
    func opensAsInk() throws {
        #expect(try #require(WhiteboardScene(json: "")).opensAsInk)
        #expect(try #require(WhiteboardScene(json: scene([foreignRect]))).opensAsInk == false)
        let mixed = try #require(InkScene.apply(InkEdit(added: [pen]), to: scene([foreignRect]), stamp: pinned()))
        #expect(try #require(WhiteboardScene(json: mixed.scene)).opensAsInk)
    }
}
