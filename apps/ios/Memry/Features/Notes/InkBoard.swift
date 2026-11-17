import MemryCore
import Observation
import PencilKit

// The drawing surface's state (#4378): the canvas's ink as PencilKit strokes,
// its other elements as a picture under them, and the saves. A save reads the
// canvas as stored now and applies only what changed on the surface
// (`InkScene.apply`), so a desktop edit that synced in meanwhile is kept.
// Saves run one at a time, 800 ms after the drawing settles, as desktop's
// whiteboard does, and Done saves what is left.

@MainActor
@Observable
final class InkBoard {
    enum Phase: Equatable {
        case loading
        case open
        case unavailable(String)
    }

    let canvasId: String
    private let boards: any WhiteboardBoards
    private(set) var phase: Phase = .loading
    /// The canvas's elements this surface does not draw, read only.
    private(set) var background: WhiteboardScene?
    private(set) var backgroundColor = "#ffffff"
    /// Where the canvas's origin sits in the scene.
    private(set) var offset = CGPoint.zero
    /// The strokes the canvas shows after a load; bumps `loads`.
    private(set) var drawing = PKDrawing()
    private(set) var loads = 0
    var saveFailure: String?

    @ObservationIgnored private var ledger = InkLedger()
    @ObservationIgnored private var latest: PKDrawing?
    @ObservationIgnored private var saving: Task<Bool, Never>?
    @ObservationIgnored private var settle: Task<Void, Never>?
    @ObservationIgnored var stamp = InkStamp()
    @ObservationIgnored var settleDelay: Duration = .milliseconds(800)

    /// Room left around the board's drawing on screen.
    private static let margin: CGFloat = 40

    init(canvasId: String, boards: any WhiteboardBoards) {
        self.canvasId = canvasId
        self.boards = boards
    }

    func load() async {
        do {
            guard let record = try await boards.board(canvasId) else {
                phase = .unavailable("\(WhiteboardCopy.missingTitle). \(WhiteboardCopy.missingBody)")
                return
            }
            // Desktop's `unreadable` rule: no surface over a scene it cannot
            // read, or its first save would write over the drawing.
            guard let scene = WhiteboardScene(json: record.scene), let own = InkScene.strokes(in: record.scene) else {
                phase = .unavailable("\(WhiteboardCopy.unreadableTitle). \(WhiteboardCopy.unreadableBody)")
                return
            }
            let ownIds = Set(own.map(\.id))
            let bounds = scene.bounds ?? .zero
            offset = CGPoint(x: bounds.minX - Self.margin, y: bounds.minY - Self.margin)
            background = scene.excluding(ownIds)
            backgroundColor = scene.background
            let strokes = own.enumerated().map { index, element in
                element.ink.stroke(created: InkLedger.created(index: index), offset: offset)
            }
            ledger = InkLedger(zip(own, strokes).map { element, stroke in
                InkLedger.Entry(created: stroke.path.creationDate.timeIntervalSinceReferenceDate, id: element.id, ink: InkStroke(stroke, offset: offset))
            })
            drawing = PKDrawing(strokes: strokes)
            latest = nil
            loads += 1
            phase = .open
        } catch {
            if Task.isCancelled { return }
            Log.interface.error("drawing canvas did not load")
            phase = .unavailable(WhiteboardCopy.loadFailed)
        }
    }

    /// The canvas changed; it saves once it settles.
    func changed(_ drawing: PKDrawing) {
        latest = drawing
        settle?.cancel()
        settle = Task { [weak self, settleDelay] in
            try? await Task.sleep(for: settleDelay)
            guard !Task.isCancelled, let self else { return }
            _ = await self.flush()
        }
    }

    /// Saves what the canvas has not saved yet. `false` when a save failed,
    /// so the surface stays open with the drawing on it.
    func flush() async -> Bool {
        settle?.cancel()
        if let latest {
            self.latest = nil
            enqueue(latest)
        }
        return await saving?.value ?? true
    }

    private func enqueue(_ drawing: PKDrawing) {
        let previous = saving
        saving = Task { [weak self] in
            _ = await previous?.value
            guard let self else { return false }
            return await self.save(drawing)
        }
    }

    private func save(_ drawing: PKDrawing) async -> Bool {
        let strokes = drawing.strokes.map { stroke in
            (created: stroke.path.creationDate.timeIntervalSinceReferenceDate, ink: InkStroke(stroke, offset: offset))
        }
        let (edit, ids) = ledger.diff(strokes)
        guard !edit.isEmpty else { return true }
        do {
            guard let record = try await boards.board(canvasId) else {
                throw InkSaveError.canvasGone
            }
            guard let result = InkScene.apply(edit, to: record.scene, stamp: stamp) else {
                throw InkSaveError.unreadable
            }
            try await boards.save(canvasId, scene: result.scene)
            ledger.commit(strokes, ids: ids, addedIds: result.addedIds)
            return true
        } catch {
            Log.interface.error("drawing did not save")
            // A later save retries the same edit against the stored scene.
            latest = latest ?? drawing
            saveFailure = switch error {
            case InkSaveError.canvasGone: "\(WhiteboardCopy.missingTitle). \(WhiteboardCopy.missingBody)"
            case InkSaveError.unreadable: "\(WhiteboardCopy.unreadableTitle). \(WhiteboardCopy.unreadableBody)"
            default: ErrorMapping.userFacing(error).guidance ?? WhiteboardCopy.saveFailed
            }
            return false
        }
    }
}

private enum InkSaveError: Error {
    case canvasGone
    case unreadable
}
