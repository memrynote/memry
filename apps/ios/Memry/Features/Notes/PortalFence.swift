import Foundation

// A `memry-portal` code block's definition, read only as far as the shell
// needs it (protocol chapter 12 §12.6.3). Resolving it against the source
// note is the core's (`Notes.portalSlice`); this file only names the target so
// the screen can guard cycles, title the header and pull the right body.
// Nothing here writes: the fence text is never rebuilt from these values.

/// What a portal points at.
enum PortalTarget: Equatable, Sendable {
    case note(id: String)
    case block(id: String, anchor: String)
    /// A query over the vault's blocks. Desktop answers it; this build shows
    /// the query and an Open-in-desktop hint.
    case search(text: String?, tag: String?)
}

/// A portal fence read for its target. `target == nil` means the JSON is not
/// a definition this build can name a target from; the core's `invalid`
/// status is the authority, and the bytes stay as they are.
struct PortalFence: Equatable, Sendable {
    static let language = "memry-portal"

    let target: PortalTarget?
    /// Anchors the definition hides. Entries that are not anchors are dropped
    /// on read (§12.6.3), so they are not counted.
    let hiddenCount: Int

    init(text: String) {
        guard let data = text.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            target = nil
            hiddenCount = 0
            return
        }
        if let note = json["note"] as? String, !note.isEmpty {
            if let anchor = json["block"] as? String, Self.isAnchor(anchor) {
                target = .block(id: note, anchor: anchor)
            } else {
                target = .note(id: note)
            }
        } else if let search = json["search"] as? [String: Any] {
            let text = (search["text"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            let tag = (search["tag"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            target = text == nil && tag == nil ? nil : .search(text: text, tag: tag)
        } else {
            target = nil
        }
        hiddenCount = (json["hidden"] as? [Any])?.compactMap { $0 as? String }.filter(Self.isAnchor).count ?? 0
    }

    /// `[a-z0-9][a-z0-9-]{3,31}`, the anchor grammar of §12.6.3.
    static func isAnchor(_ value: String) -> Bool {
        let scalars = Array(value.unicodeScalars)
        guard (4...32).contains(scalars.count) else { return false }
        func lower(_ s: Unicode.Scalar) -> Bool { ("a"..."z").contains(s) || ("0"..."9").contains(s) }
        return lower(scalars[0]) && scalars.dropFirst().allSatisfy { lower($0) || $0 == "-" }
    }
}

/// The chain of notes between the note on screen and a portal, outermost
/// first, mirroring desktop's `portal-state.ts` so both draw the same refusal.
struct PortalAncestry: Equatable, Sendable {
    enum Frame: Equatable, Sendable {
        case host(note: String)
        case window(note: String, block: String?)

        var note: String {
            switch self {
            case let .host(note), let .window(note, _): note
            }
        }
    }

    /// Windows nested at most this deep, then a portal opens as a link.
    static let maxDepth = 3

    var frames: [Frame] = []

    var windowDepth: Int {
        frames.filter { if case .window = $0 { true } else { false } }.count
    }

    /// The ancestry as seen from a portal inside `note`, which is not itself
    /// a window.
    func withHost(_ note: String?) -> PortalAncestry {
        guard let note, frames.last?.note != note else { return self }
        return PortalAncestry(frames: frames + [.host(note: note)])
    }

    /// The ancestry inside the window `target` opens.
    func descending(into target: PortalTarget) -> PortalAncestry {
        switch target {
        case let .note(id): PortalAncestry(frames: frames + [.window(note: id, block: nil)])
        case let .block(id, anchor): PortalAncestry(frames: frames + [.window(note: id, block: anchor)])
        case .search: self
        }
    }

    enum Refusal: Equatable, Sendable { case cycle, tooDeep }

    /// A whole-note target loops against any frame on that note. A block
    /// target loops only against a window on that same block: a block of the
    /// host note is fine until the portal sits inside it, when the window it
    /// opens is the frame that catches it one level down.
    func refusal(for target: PortalTarget) -> Refusal? {
        switch target {
        case .search:
            return nil
        case let .note(id):
            if frames.contains(where: { $0.note == id }) { return .cycle }
        case let .block(id, anchor):
            if frames.contains(where: { $0 == .window(note: id, block: anchor) }) { return .cycle }
        }
        return windowDepth >= Self.maxDepth ? .tooDeep : nil
    }
}
