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
    /// Saves enqueued and not yet landed.
    @ObservationIgnored private var queued = 0
    /// The board the surface shows, as each element's version: the scene
    /// last read, or last written over what the surface showed.
    @ObservationIgnored private var shown: [String: Int] = [:]
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
            guard show(record.scene) else {
                phase = .unavailable("\(WhiteboardCopy.unreadableTitle). \(WhiteboardCopy.unreadableBody)")
                return
            }
            latest = nil
            phase = .open
        } catch {
            if Task.isCancelled { return }
            Log.interface.error("drawing canvas did not load")
            phase = .unavailable(WhiteboardCopy.loadFailed)
        }
    }

    /// Puts `scene` on the surface: its ink as strokes, the rest under them.
    private func show(_ scene: String) -> Bool {
        guard let picture = WhiteboardScene(json: scene), let own = InkScene.strokes(in: scene),
              let versions = InkScene.versions(in: scene)
        else { return false }
        let bounds = picture.bounds ?? .zero
        offset = CGPoint(x: bounds.minX - Self.margin, y: bounds.minY - Self.margin)
        background = picture.excluding(Set(own.map(\.id)))
        backgroundColor = picture.background
        let strokes = own.enumerated().map { index, element in
            element.ink.stroke(created: InkLedger.created(index: index), offset: offset)
        }
        ledger = InkLedger(zip(own, strokes).map { element, stroke in
            InkLedger.Entry(created: stroke.path.creationDate.timeIntervalSinceReferenceDate, id: element.id, ink: InkStroke(stroke, offset: offset))
        })
        drawing = PKDrawing(strokes: strokes)
        shown = versions
        loads += 1
        return true
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
        queued += 1
        saving = Task { [weak self] in
            _ = await previous?.value
            guard let self else { return false }
            defer { self.queued -= 1 }
            return await self.save(drawing)
        }
    }

    private func save(_ drawing: PKDrawing) async -> Bool {
        let strokes = drawing.strokes.flatMap { stroke in
            InkStroke.visible(stroke, offset: offset).map { (created: stroke.path.creationDate.timeIntervalSinceReferenceDate, ink: $0) }
        }
        let (edit, ids) = ledger.diff(strokes)
        guard !edit.isEmpty else { return true }
        do {
            guard let record = try await boards.board(canvasId) else {
                throw InkSaveError.canvasGone
            }
            // The iPad writes only its own changes since its last read or
            // write. An element absent from the stored scene was removed
            // elsewhere: a desktop erase, which leaves no tombstone, or a
            // pull that moved this canvas into a conflict copy, which keeps
            // it, as desktop's own whiteboard does. It is never written back.
            guard let stored = InkScene.versions(in: record.scene),
                  let result = InkScene.apply(edit, to: record.scene, stamp: stamp),
                  let written = InkScene.versions(in: result.scene)
            else {
                throw InkSaveError.unreadable
            }
            try await boards.save(canvasId, scene: result.scene)
            ledger.commit(strokes, ids: ids, addedIds: result.addedIds)
            requestSync?()
            if stored == shown {
                shown = written
            } else if latest == nil, queued == 1 {
                // The board changed under the surface: show it as stored, so
                // the user sees what desktop sees. With more drawing still to
                // save, the next save does this.
                _ = show(result.scene)
            }
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
