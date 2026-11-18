import CoreGraphics
import Foundation
import MemryCore
import PencilKit
import Testing
import UIKit

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

    @Test("only a board with the surface's ink opens in the surface; an empty or desktop-only board opens Excalidraw")
    func opensAsInk() throws {
        #expect(try #require(WhiteboardScene(json: "")).opensAsInk == false)
        #expect(try #require(WhiteboardScene(json: scene([]))).opensAsInk == false)
        #expect(try #require(WhiteboardScene(json: scene([foreignRect]))).opensAsInk == false)
        let mixed = try #require(InkScene.apply(InkEdit(added: [pen]), to: scene([foreignRect]), stamp: pinned()))
        #expect(try #require(WhiteboardScene(json: mixed.scene)).opensAsInk)
    }
}

/// A canvas store whose stored scene a test replaces, as a sync pull does.
@MainActor
private final class FakeInkBoards: WhiteboardBoards, @unchecked Sendable {
    var scene: String?
    var saves = 0
    /// Pulls that land after a save read the board and before it writes,
    /// one per write, each changing the stored scene.
    var pulls: [(String) -> String] = []
    /// The note's other canvases, as `boards(ownedBy:)` lists them.
    var others: [CanvasRecord] = []
    /// Saves still to fail, one each.
    var failures = 0
    /// While set, each save waits in `held` until `resume()`.
    var holding = false
    private(set) var held: [CheckedContinuation<Void, Never>] = []

    init(scene: String) { self.scene = scene }

    func resume() {
        holding = false
        held.forEach { $0.resume() }
        held = []
    }

    func board(_ id: String) async throws -> CanvasRecord? {
        scene.map { CanvasRecord(id: id, title: "Drawing", ownerNoteId: "n1", scene: $0) }
    }

    func create(title: String, ownerNoteId: String) async throws -> CanvasRecord {
        CanvasRecord(id: "c1", title: title, ownerNoteId: ownerNoteId, scene: "")
    }

    func save(_ id: String, scene: String) async throws {
        try await land()
        saves += 1
        self.scene = scene
    }

    func save(_ id: String, scene: String, expected: String) async throws -> CanvasSceneWrite {
        try await land()
        guard let stored = self.scene, let current = try await board(id) else { throw StorageError.NotFound(what: id) }
        guard stored == expected else { return .stale(current: current) }
        saves += 1
        self.scene = scene
        return .written(canvas: CanvasRecord(id: id, title: "Drawing", ownerNoteId: "n1", scene: scene))
    }

    func boards(ownedBy noteId: String) async throws -> [CanvasRecord] {
        let own = try await board("c1").map { [$0] } ?? []
        return own + others.filter { $0.ownerNoteId == noteId }
    }

    /// What happens to a write before it reaches the store.
    private func land() async throws {
        if holding { await withCheckedContinuation { held.append($0) } }
        if failures > 0 {
            failures -= 1
            throw URLError(.notConnectedToInternet)
        }
        if !pulls.isEmpty, let stored = scene { scene = pulls.removeFirst()(stored) }
    }
}

/// A pull that stores a desktop shape in the scene.
private func pull(_ element: String) -> (String) -> String {
    { stored in
        let empty = stored.contains(##""elements":[]"##)
        return stored.replacingOccurrences(of: ##""elements":["##, with: ##""elements":["## + element + (empty ? "" : ","))
    }
}

@MainActor
@Suite("the drawing surface's saves")
struct InkBoardSaveTests {
    /// Strokes on the surface, each drawn at its own `created` date.
    private func drawing(_ board: InkBoard, _ strokes: [(created: Double, ink: InkStroke)]) -> PKDrawing {
        PKDrawing(strokes: strokes.map { $0.ink.stroke(created: Date(timeIntervalSinceReferenceDate: $0.created), offset: board.offset) })
    }

    private func open(_ fake: FakeInkBoards) async -> InkBoard {
        let board = InkBoard(canvasId: "c1", boards: fake)
        board.stamp = pinned()
        board.settleDelay = .seconds(3600)
        await board.load()
        return board
    }

    @Test(.timeLimit(.minutes(1))) func resigning_active_saves_under_a_background_task() async {
        let fake = FakeInkBoards(scene: scene([]))
        let board = await open(fake)
        var ended: [UIBackgroundTaskIdentifier] = []
        board.beginBackgroundTask = { _ in UIBackgroundTaskIdentifier(rawValue: 7) }
        board.endBackgroundTask = { ended.append($0) }
        board.changed(drawing(board, [(1, pen)]))

        NotificationCenter.default.post(name: UIApplication.willResignActiveNotification, object: nil)
        while ended.isEmpty { try? await Task.sleep(for: .milliseconds(10)) }

        #expect(fake.saves == 1)
        #expect(ended == [UIBackgroundTaskIdentifier(rawValue: 7)], "the task ends once the save lands")
        #expect(InkScene.strokes(in: fake.scene ?? "")?.map(\.ink) == [pen])
    }

    @Test func desktopEraseSurvivesIPadSave() async throws {
        let fake = FakeInkBoards(scene: scene([]))
        let board = await open(fake)
        var syncs = 0
        board.requestSync = { syncs += 1 }
        var second = pen
        second.color = "#2f9e44"
        var third = pen
        third.width = 2

        board.changed(drawing(board, [(1, pen)]))
        #expect(await board.flush())
        #expect(syncs == 1, "a save asks for a sync pass")
        // Desktop erased the stroke and drew a shape. It saves the scene's
        // live elements, so the erase leaves no tombstone. A pull that moved
        // this canvas into a conflict copy leaves the same scene.
        fake.scene = scene([foreignRect])
        let loads = board.loads
        board.changed(drawing(board, [(1, pen), (2, second)]))
        #expect(await board.flush())
        let stored = try #require(fake.scene)
        #expect(stored.contains(foreignRect))
        #expect(try #require(InkScene.strokes(in: stored)).map(\.ink) == [second], "the erased stroke stays erased")
        #expect(syncs == 2)
        #expect(board.loads == loads + 1, "the surface shows the board as stored")
        #expect(board.drawing.strokes.map { InkStroke($0, offset: board.offset) } == [second])

        // An erase desktop left as a tombstone stays erased too.
        let secondId = try #require(InkScene.strokes(in: stored)?.first?.id)
        fake.scene = try #require(InkScene.apply(InkEdit(erased: [secondId]), to: stored, stamp: pinned())).scene
        board.changed(PKDrawing(strokes: board.drawing.strokes + [third.stroke(created: Date(timeIntervalSinceReferenceDate: 3), offset: board.offset)]))
        #expect(await board.flush())
        #expect(try #require(InkScene.strokes(in: fake.scene ?? "")).map(\.ink) == [third])
    }

    @Test func a_save_over_an_unchanged_board_keeps_the_surface_as_drawn() async {
        let fake = FakeInkBoards(scene: scene([foreignRect]))
        let board = await open(fake)
        let loads = board.loads
        board.changed(drawing(board, [(1, pen)]))
        #expect(await board.flush())
        board.changed(drawing(board, [(1, pen), (2, pen)]))
        #expect(await board.flush())
        #expect(InkScene.strokes(in: fake.scene ?? "")?.count == 2)
        #expect(board.loads == loads, "no reload while only this surface wrote")
    }

    @Test func pixelEraseSplit() async throws {
        let fake = FakeInkBoards(scene: scene([]))
        let board = await open(fake)
        let line = InkStroke(
            points: (0 ... 10).map { CGPoint(x: Double($0) * 10, y: 50) }, pressures: Array(repeating: 0.5, count: 11),
            color: "#1e1e1e", width: 1, opacity: 100, inkType: PKInk.InkType.pen.rawValue
        )
        board.changed(drawing(board, [(1, line)]))
        #expect(await board.flush())
        // A pixel eraser through the middle leaves the stroke twice, each
        // copy masked to one side, under the one creation date.
        let whole = line.stroke(created: Date(timeIntervalSinceReferenceDate: 1), offset: board.offset)
        let side = { (minX: Double, maxX: Double) in
            PKStroke(ink: whole.ink, path: whole.path, transform: .identity, mask: UIBezierPath(rect: CGRect(
                x: minX - board.offset.x, y: 0 - board.offset.y, width: maxX - minX, height: 100
            )))
        }
        board.changed(PKDrawing(strokes: [side(62, 120), side(-20, 38)]))
        #expect(await board.flush())
        let stored = try #require(InkScene.strokes(in: fake.scene ?? ""))
        #expect(stored.count == 2, "each visible part is one stroke")
        let spans = stored.map { ($0.ink.points.map(\.x).min() ?? 0, $0.ink.points.map(\.x).max() ?? 0) }
        #expect(spans.allSatisfy { $0.1 <= 40 || $0.0 >= 60 }, "nothing erased comes back: \(spans)")
        #expect(spans.contains { $0.0 < 1 } && spans.contains { $0.1 > 99 })
    }

    @Test("a marker reopens with the tilt and opacity PencilKit drew it with")
    func markerTilt() throws {
        let points = [CGPoint(x: 0, y: 0), CGPoint(x: 40, y: 10)].map {
            PKStrokePoint(location: $0, timeOffset: 0, size: CGSize(width: 13.75, height: 13.75), opacity: 1.5, force: 0, azimuth: 1.8157, altitude: .pi / 2)
        }
        let drawn = PKStroke(ink: PKInk(.marker, color: UIColor(red: 1, green: 0.8, blue: 0.2, alpha: 0.8)), path: PKStrokePath(controlPoints: points, creationDate: .now))
        let ink = InkStroke(drawn, offset: .zero)
        #expect(ink.tilt == InkTilt(azimuth: 1.816, altitude: 1.571, opacity: 1.5))
        let written = try #require(InkScene.apply(InkEdit(added: [ink]), to: "", stamp: pinned()))
        let read = try #require(InkScene.strokes(in: written.scene)?.first?.ink)
        #expect(read == ink)
        let reopened = read.stroke(created: .now, offset: .zero)
        let point = try #require(reopened.path.first)
        #expect(abs(point.azimuth - 1.816) < 0.001 && abs(point.opacity - 1.5) < 0.001)
        #expect(abs(point.size.width - 13.75) < 0.1, "the width keeps Excalidraw's 0.01 rounding")
    }

    @Test("a save tells added, changed and erased strokes apart, and a lasso copy is new")
    func addedChangedErased() async throws {
        let fake = FakeInkBoards(scene: scene([]))
        let board = await open(fake)
        var moved = pen
        moved.width = 2
        board.changed(drawing(board, [(1, pen), (2, pen), (3, pen)]))
        #expect(await board.flush())
        let strokes: [(created: Double, ink: InkStroke)] = [(1, pen), (2, moved), (2, moved), (99, pen)]
        board.changed(drawing(board, strokes))
        #expect(await board.flush())
        let stored = try elements(try #require(fake.scene))
        #expect(stored.map { $0["id"] as? String } == ["ink-1", "ink-2", "ink-3", "ink-4", "ink-5"])
        #expect(stored.map { $0["isDeleted"] as? Bool } == [false, false, true, false, false])
        #expect(stored.map { $0["version"] as? Int } == [1, 2, 2, 1, 1], "only the changed and erased strokes are rewritten")
        #expect(try #require(InkScene.strokes(in: fake.scene ?? "")).map(\.ink) == [pen, moved, moved, pen])
        let saves = fake.saves
        board.changed(drawing(board, strokes))
        #expect(await board.flush())
        #expect(fake.saves == saves, "nothing changed, nothing saved")
    }

    /// Drawing A starts saving and waits in the store; B is handed over and
    /// queued behind it; then the store fails the next `failures` saves.
    private func saveAThenB(_ fake: FakeInkBoards, failures: Int) async -> (board: InkBoard, a: Bool, b: Bool) {
        let board = await open(fake)
        var second = pen
        second.color = "#2f9e44"
        fake.holding = true
        fake.failures = failures
        board.changed(drawing(board, [(1, pen)]))
        let settled = Task { await board.flush() }
        while fake.held.isEmpty { try? await Task.sleep(for: .milliseconds(10)) }
        board.changed(drawing(board, [(1, pen), (2, second)]))
        let done = Task { await board.flush() }
        // Lets Done's flush queue B behind A before A's save goes on.
        try? await Task.sleep(for: .milliseconds(10))
        fake.resume()
        return (board, await settled.value, await done.value)
    }

    @Test(.timeLimit(.minutes(1)))
    func a_failed_save_never_brings_back_an_older_drawing_than_a_newer_save() async throws {
        let fake = FakeInkBoards(scene: scene([]))
        let (board, a, b) = await saveAThenB(fake, failures: 1)
        #expect(a == false)
        #expect(b)
        #expect(InkScene.strokes(in: fake.scene ?? "")?.count == 2)
        // onDisappear after Done: nothing new to save.
        #expect(await board.flush())
        #expect(InkScene.strokes(in: fake.scene ?? "")?.count == 2, "the stroke drawn after the failed save stays")
    }

    @Test(.timeLimit(.minutes(1)))
    func when_both_saves_fail_the_retry_saves_the_newest_drawing() async throws {
        let fake = FakeInkBoards(scene: scene([]))
        let (board, a, b) = await saveAThenB(fake, failures: 2)
        #expect(a == false)
        #expect(b == false)
        #expect(await board.flush())
        #expect(InkScene.strokes(in: fake.scene ?? "")?.count == 2, "the retry saves both strokes")
    }

    @Test func a_pull_landing_between_the_read_and_the_write_is_kept() async throws {
        // #4820: the save read the board, then a pull stored a desktop shape.
        let fake = FakeInkBoards(scene: scene([]))
        let board = await open(fake)
        fake.pulls = [pull(foreignRect)]
        board.changed(drawing(board, [(1, pen)]))
        #expect(await board.flush())
        let stored = try #require(fake.scene)
        #expect(stored.contains(foreignRect), "the pulled desktop shape stays")
        #expect(try #require(InkScene.strokes(in: stored)).map(\.ink) == [pen])
        #expect(board.background?.elements.map(\.id) == ["rect-1"], "the surface shows the board as stored")
    }

    @Test func a_save_that_keeps_meeting_pulls_retries_and_keeps_every_stroke() async throws {
        let fake = FakeInkBoards(scene: scene([]))
        let board = await open(fake)
        var second = pen
        second.color = "#2f9e44"
        let rect2 = foreignRect.replacingOccurrences(of: "rect-1", with: "rect-2")
        fake.pulls = [pull(foreignRect), pull(rect2)]
        board.changed(drawing(board, [(1, pen), (2, second)]))
        #expect(await board.flush())
        let stored = try #require(fake.scene)
        #expect(stored.contains(foreignRect) && stored.contains(rect2))
        #expect(try #require(InkScene.strokes(in: stored)).map(\.ink) == [pen, second], "each stroke written once")
        #expect(fake.saves == 1)
    }

    @Test func a_save_that_never_lands_keeps_the_strokes_for_the_next_one() async throws {
        let fake = FakeInkBoards(scene: scene([]))
        let board = await open(fake)
        fake.pulls = (0 ..< InkBoard.saveAttempts).map { pull(foreignRect.replacingOccurrences(of: "rect-1", with: "rect-\($0)")) }
        board.changed(drawing(board, [(1, pen)]))
        #expect(await board.flush() == false)
        #expect(board.saveFailure != nil)
        #expect(board.canvasLost == false, "the canvas is still there: Done tries again")
        #expect(try #require(InkScene.strokes(in: fake.scene ?? "")).isEmpty)
        #expect(await board.flush())
        let stored = try #require(fake.scene)
        #expect(try #require(InkScene.strokes(in: stored)).map(\.ink) == [pen])
        #expect(stored.contains("rect-0") && stored.contains("rect-2"))
    }

    @Test func the_boards_conflict_copy_is_listed_and_another_whiteboard_is_not() async {
        let fake = FakeInkBoards(scene: scene([]))
        fake.others = [CanvasRecord(id: "c3", title: "Sketches", ownerNoteId: "n1", scene: scene([]))]
        let board = await open(fake)
        #expect(board.conflictCopy == nil)
        // A pull moved this board's iPad ink into a copy while it was open.
        fake.others.append(CanvasRecord(id: "c2", title: "Drawing (conflict copy)", ownerNoteId: "n1", scene: scene([])))
        fake.others.append(CanvasRecord(id: "c4", title: "Drawing (conflict copy)", ownerNoteId: "n9", scene: scene([])))
        await board.findCopies()
        #expect(board.conflictCopy?.id == "c2")
    }

    @Test func a_canvas_deleted_while_open_lets_the_surface_close() async {
        let fake = FakeInkBoards(scene: scene([]))
        let board = await open(fake)
        #expect(board.canvasLost == false)
        fake.scene = nil
        board.changed(drawing(board, [(1, pen)]))
        #expect(await board.flush() == false)
        #expect(board.saveFailure != nil)
        #expect(board.canvasLost, "Done can never save, so the alert offers to close")
    }
}

@MainActor
struct InkCanvasTests {
    @Test("picking the pixel eraser leaves the canvas erasing whole strokes; other tools pass through")
    func pixelEraserPickErasesWholeStrokes() async throws {
        let coordinator = InkCanvas.Coordinator(board: InkBoard(canvasId: "c1", boards: FakeInkBoards(scene: scene([]))))
        let canvas = InkCanvasView()
        coordinator.canvas = canvas
        for type in [PKEraserTool.EraserType.bitmap, .fixedWidthBitmap] {
            canvas.tool = PKEraserTool(type)
            coordinator.toolPickerSelectedToolItemDidChange(coordinator.picker)
            await withCheckedContinuation { done in DispatchQueue.main.async { done.resume() } }
            #expect((canvas.tool as? PKEraserTool)?.eraserType == .vector)
        }
        let pen = PKInkingTool(.pen, color: .red, width: 4)
        canvas.tool = pen
        coordinator.toolPickerSelectedToolItemDidChange(coordinator.picker)
        await withCheckedContinuation { done in DispatchQueue.main.async { done.resume() } }
        #expect(canvas.tool as? PKInkingTool == pen)
    }

    @Test("the tool picker shows the object eraser the canvas erases with")
    func toolPickerShowsObjectEraser() throws {
        let picker = InkCanvas.makeToolPicker()
        let eraser = try #require(picker.toolItems.compactMap { $0 as? PKToolPickerEraserItem }.first)
        #expect(eraser.eraserTool.eraserType == .vector)
    }

    @Test("a canvas that loads its ink before its first layout takes strokes across its whole bounds")
    func reopenedCanvasDrawsEverywhere() {
        let canvas = InkCanvasView()
        canvas.drawing = PKDrawing(strokes: [pen.stroke(created: .now, offset: .zero)])
        canvas.fitContent()
        canvas.frame = CGRect(x: 0, y: 0, width: 1024, height: 1280)
        canvas.layoutIfNeeded()
        #expect(canvas.contentSize.width >= 1024)
        #expect(canvas.contentSize.height >= 1280)
    }
}
