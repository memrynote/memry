import MemryCore
import Observation
import PencilKit
import UIKit

// The drawing surface's state (#4378): the canvas's ink as PencilKit strokes,
// its other elements as a picture under them, and the saves. A save reads the
// canvas as stored now and applies only what changed on the surface
// (`InkScene.apply`), so a desktop edit that synced in meanwhile is kept.
// Saves run one at a time, 800 ms after the drawing settles, as desktop's
// whiteboard does, and Done saves what is left. The app resigning active saves
// too, under a background task, as `EditorSession` does for typing (#2820).
// A stroke saved before that a sync pull dropped from the stored scene (a
// conflict copy took it) is written back with the next save.

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
    /// The canvas was deleted or is unreadable: nothing on the surface can
    /// be saved, so it may close without saving.
    private(set) var canvasLost = false
    /// Schedules a vault sync pass (debounced) after each save.
    @ObservationIgnored var requestSync: (@MainActor () -> Void)?

    @ObservationIgnored private var ledger = InkLedger()
    @ObservationIgnored private var latest: PKDrawing?
    @ObservationIgnored private var saving: Task<Bool, Never>?
    @ObservationIgnored private var settle: Task<Void, Never>?
    @ObservationIgnored var stamp = InkStamp()
    @ObservationIgnored var settleDelay: Duration = .milliseconds(800)
    @ObservationIgnored private nonisolated(unsafe) var resignObserver: NSObjectProtocol?
    @ObservationIgnored private var heldTasks: Set<UIBackgroundTaskIdentifier> = []
    /// Seam for tests; the app holds tasks from `UIApplication`.
    @ObservationIgnored var beginBackgroundTask: (@escaping () -> Void) -> UIBackgroundTaskIdentifier = {
        UIApplication.shared.beginBackgroundTask(withName: "drawing-save", expirationHandler: $0)
    }
    @ObservationIgnored var endBackgroundTask: (UIBackgroundTaskIdentifier) -> Void = {
        UIApplication.shared.endBackgroundTask($0)
    }

    /// Room left around the board's drawing on screen.
    private static let margin: CGFloat = 40

    init(canvasId: String, boards: any WhiteboardBoards) {
        self.canvasId = canvasId
        self.boards = boards
        // A kill from the app switcher beats the settle delay, and swiping
        // into the switcher never backgrounds the app.
        resignObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.willResignActiveNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.saveBeforeLeaving() }
        }
    }

    deinit {
        if let resignObserver { NotificationCenter.default.removeObserver(resignObserver) }
    }

    /// Saves what is left, holding a background task until the save lands.
    private func saveBeforeLeaving() {
        guard latest != nil || saving != nil else { return }
        var id = UIBackgroundTaskIdentifier.invalid
        id = beginBackgroundTask {
            MainActor.assumeIsolated { self.release(id) }
        }
        guard id != .invalid else { return }
        heldTasks.insert(id)
        Task { @MainActor in
            _ = await self.flush()
            self.release(id)
        }
    }

    /// Ends `id` once, whichever of expiry or the landed save gets here first.
    private func release(_ id: UIBackgroundTaskIdentifier) {
        guard heldTasks.remove(id) != nil else { return }
        endBackgroundTask(id)
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
        var (edit, ids) = ledger.diff(strokes)
        guard !edit.isEmpty else { return true }
        do {
            guard let record = try await boards.board(canvasId) else {
                throw InkSaveError.canvasGone
            }
            guard let stored = InkScene.elementIds(in: record.scene) else {
                throw InkSaveError.unreadable
            }
            // A saved stroke whose element left the stored scene, as when a
            // pull moved this device's scene into a conflict copy, is written
            // back. One desktop deleted keeps its tombstone, so stays erased.
            for (stroke, id) in zip(strokes, ids) {
                if let id, !stored.contains(id), edit.changed[id] == nil { edit.changed[id] = stroke.ink }
            }
            guard let result = InkScene.apply(edit, to: record.scene, stamp: stamp) else {
                throw InkSaveError.unreadable
            }
            try await boards.save(canvasId, scene: result.scene)
            ledger.commit(strokes, ids: ids, addedIds: result.addedIds)
            requestSync?()
            return true
        } catch {
            Log.interface.error("drawing did not save")
            // A later save retries the same edit against the stored scene.
            latest = latest ?? drawing
            canvasLost = error is InkSaveError
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
