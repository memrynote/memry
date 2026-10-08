import MemryCore
import SwiftUI

// Desktop's whiteboard block (`whiteboard-block.tsx`): a `canvasId` prop
// naming a canvas record, drawn as the board's picture under its title. A tap
// opens the board in Excalidraw (`WhiteboardEditor`).
//
// **The picture is drawn natively.** Excalidraw in a web view takes about
// half a second to start, and its export is the note's plaintext as pixels,
// which may not sit in a disk cache. So the preview reads the scene and
// draws its shapes, lines and text here, every time, in memory: plain
// strokes rather than Excalidraw's hand-drawn ones, the same layout.

/// The canvas reads and writes a whiteboard needs.
protocol WhiteboardBoards: Sendable {
    /// The live canvas, or `nil` when it was deleted or has not synced yet.
    func board(_ id: String) async throws -> CanvasRecord?
    func create(title: String, ownerNoteId: String) async throws -> CanvasRecord
    func save(_ id: String, scene: String) async throws
}

/// The production surface: the core's `Canvases`, over the shell's one
/// serial core queue.
struct CoreWhiteboardBoards: WhiteboardBoards {
    let vault: Vault
    let store: any SecureStore
    let executor: CoreExecutor

    /// Minted per call, as `CoreNoteTasks` does: the device key is read when
    /// the write happens.
    private func canvases() throws -> Canvases {
        try vault.canvases(store: store)
    }

    func board(_ id: String) async throws -> CanvasRecord? {
        try await executor.run { try canvases().canvas(id: id) }
    }

    func create(title: String, ownerNoteId: String) async throws -> CanvasRecord {
        try await executor.run { try canvases().create(title: title, ownerNoteId: ownerNoteId, scene: nil) }
    }

    func save(_ id: String, scene: String) async throws {
        _ = try await executor.run { try canvases().setScene(id: id, scene: scene) }
    }
}

extension EnvironmentValues {
    /// `nil` where the vault has no device identity to write under.
    @Entry var whiteboards: (any WhiteboardBoards)?
}

enum WhiteboardCopy {
    static let title = "Whiteboard"
    static let untitled = "Untitled whiteboard"
    static let loading = "Loading whiteboard…"
    static let noCanvas = "This whiteboard has no canvas. Remove the block, or add a new one with /whiteboard."
    static let missingTitle = "This whiteboard is not available"
    static let missingBody = "Its canvas was deleted, or has not reached this device yet. If it is still syncing, it appears here on its own."
    static let unreadableTitle = "This whiteboard cannot be opened here"
    static let unreadableBody = "Its canvas file is missing from the vault or cannot be read on this device. Nothing was deleted."
    static let loadFailed = "Could not load this whiteboard. The drawing itself is untouched."
    static let createFailed = "Could not create the whiteboard. Nothing was added to the note."
    static let saveFailed = "The drawing is still on the board. Try Done again."
    static let empty = "Empty board. Tap to draw."
    static let image = "Image"

    /// Desktop's `editor.whiteboard.noteName` / `defaultName`.
    static func name(forNote title: String?) -> String {
        let trimmed = title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? Self.title : "\(trimmed) whiteboard"
    }
}

/// What the block knows about its canvas.
enum WhiteboardBoard: Equatable {
    case loading
    case missing
    case failed
    /// The canvas is here but its scene is not an Excalidraw document.
    case unreadable(title: String?)
    case ready(title: String?, scene: WhiteboardScene)
}

struct WhiteboardBlockView: View {
    let canvasId: String
    /// Opens the editor. `nil` on a read-only page.
    var edit: ((String, String) -> Void)?
    /// Re-reads the canvas when it changes: a finished sync pass, a closed
    /// editor.
    var revision: Int = 0

    @Environment(\.whiteboards) private var boards
    @Environment(\.vaultSyncPasses) private var syncPasses
    @State private var board: WhiteboardBoard = .loading

    var body: some View {
        content
            .frame(maxWidth: .infinity, alignment: .leading)
            .task(id: "\(canvasId)|\(syncPasses)|\(revision)") { await load() }
    }

    private func load() async {
        guard let boards, !canvasId.isEmpty else { return }
        do {
            guard let record = try await boards.board(canvasId) else {
                board = .missing
                return
            }
            board = WhiteboardScene(json: record.scene).map { .ready(title: record.title, scene: $0) }
                ?? .unreadable(title: record.title)
        } catch {
            Log.interface.error("whiteboard canvas did not load")
            board = .failed
        }
    }

    @ViewBuilder
    private var content: some View {
        if canvasId.isEmpty {
            WhiteboardNotice(title: nil, message: WhiteboardCopy.noCanvas)
        } else {
            switch board {
            case .loading:
                WhiteboardNotice(title: nil, message: WhiteboardCopy.loading)
            case .missing:
                WhiteboardNotice(title: WhiteboardCopy.missingTitle, message: WhiteboardCopy.missingBody)
            case .failed:
                WhiteboardNotice(title: nil, message: WhiteboardCopy.loadFailed)
            case let .unreadable(title):
                WhiteboardNotice(
                    title: title ?? WhiteboardCopy.unreadableTitle,
                    message: title == nil ? WhiteboardCopy.unreadableBody : "\(WhiteboardCopy.unreadableTitle). \(WhiteboardCopy.unreadableBody)"
                )
            case let .ready(title, scene):
                let name = title.flatMap { $0.isEmpty ? nil : $0 } ?? WhiteboardCopy.untitled
                if let edit {
                    Button { edit(canvasId, name) } label: { WhiteboardCard(title: name, scene: scene) }
                        .buttonStyle(.plain)
                        .accessibilityHint("Opens the board to draw")
                } else {
                    WhiteboardCard(title: name, scene: scene)
                }
            }
        }
    }
}

/// The board's title over its picture.
private struct WhiteboardCard: View {
    let title: String
    let scene: WhiteboardScene

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.small) {
            Label(title, systemImage: "pencil.and.scribble")
                .font(Tokens.Typography.supporting.font)
                .foregroundStyle(Tokens.Text.secondary.color)
                .lineLimit(1)
            WhiteboardPicture(scene: scene)
        }
        .padding(.vertical, Tokens.Space.small)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Whiteboard, \(title)")
        .accessibilityValue(scene.elements.isEmpty ? "Empty" : "\(scene.elements.count) shapes")
        .accessibilityAddTraits(.isButton)
    }
}

/// Desktop's `WhiteboardNotice`: a board that cannot be drawn, said in the
/// frame the drawing would use.
private struct WhiteboardNotice: View {
    let title: String?
    let message: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Tokens.Space.small) {
            Image(systemName: "pencil.and.scribble")
                .foregroundStyle(Tokens.Text.tertiary.color)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: Tokens.Space.tight) {
                if let title {
                    Text(title).foregroundStyle(Tokens.Text.primary.color)
                }
                Text(message).foregroundStyle(Tokens.Text.secondary.color)
            }
        }
        .font(Tokens.Typography.supporting.font)
        .padding(Tokens.Space.inset)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(RoundedRectangle(cornerRadius: Tokens.Radius.card).strokeBorder(Tokens.Line.border.color))
        .accessibilityElement(children: .combine)
    }
}
