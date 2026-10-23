import Foundation

// A `memry-portal` code block's definition, read only as far as the shell
// needs it (protocol chapter 12 §12.6.3). Resolving it against the source
// note is the core's (`Notes.portalSlice`); this file only names the target so
// the screen can guard cycles, title the header and pull the right body.
// Nothing here writes: the fence text is never rebuilt from these values.

/// What a portal points at (`packages/shared/src/portal-block.ts`).
enum PortalTarget: Equatable, Sendable {
    /// Every block of a note except the subtrees under the `hide` anchors. The
    /// core applies the list; the shell carries it so a target compares equal
    /// only to the same fence.
    case note(id: String, hide: [String] = [])
    /// The subtrees under these root anchors, in portal order. Which children
    /// show is the core's `open` rule; the shell never reads it.
    case blocks(id: String, roots: [String])
    /// A query over the vault's blocks. Desktop answers it; this build shows
    /// the query and says so.
    case search(text: String?, tag: String?)
}

/// A portal fence read for its target. `target == nil` means the JSON is not
/// a definition this build can name a target from; the core's `invalid`
/// status is the authority, and the bytes stay as they are.
struct PortalFence: Equatable, Sendable {
    static let language = "memry-portal"

    let target: PortalTarget?

    /// Mirrors `readPortalTarget`: `search` wins when present, then `note`
    /// with `blocks` (empty or absent: the whole note, plus its `hide` list). An
    /// absent `v` reads as 1; `open` and unknown keys are the core's and the writer's.
    init(text: String) {
        guard let data = text.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            target = nil
            return
        }
        if let search = json["search"] as? [String: Any] {
            let text = Self.nonEmpty(search["text"])
            let tag = Self.nonEmpty(search["tag"])
            target = text == nil && tag == nil ? nil : .search(text: text, tag: tag)
        } else if let note = Self.nonEmpty(json["note"]) {
            let roots = Self.anchors(json["blocks"])
            target = roots.isEmpty ? .note(id: note, hide: Self.anchors(json["hide"])) : .blocks(id: note, roots: roots)
        } else {
            target = nil
        }
    }

    /// The anchors in a JSON array, in order, repeats and non-anchors dropped.
    private static func anchors(_ value: Any?) -> [String] {
        var seen = Set<String>()
        return ((value as? [Any]) ?? []).compactMap { $0 as? String }
            .filter { isAnchor($0) && seen.insert($0).inserted }
    }

    private static func nonEmpty(_ value: Any?) -> String? {
        guard let string = value as? String,
              !string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else { return nil }
        return string
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
        /// `blocks` is `nil` for a whole-note window.
        case window(note: String, blocks: [String]?)

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
        case let .note(id, _): PortalAncestry(frames: frames + [.window(note: id, blocks: nil)])
        case let .blocks(id, roots): PortalAncestry(frames: frames + [.window(note: id, blocks: roots)])
        case .search: self
        }
    }

    enum Refusal: Equatable, Sendable { case cycle, tooDeep }

    /// A whole-note target loops against any frame on that note. A blocks
    /// target loops only against a window on that note that shares a root: a
    /// block of the host note is fine until the portal sits inside it, when
    /// the window it opens is the frame that catches it one level down.
    func refusal(for target: PortalTarget) -> Refusal? {
        switch target {
        case .search:
            return nil
        case let .note(id, _):
            if frames.contains(where: { $0.note == id }) { return .cycle }
        case let .blocks(id, roots):
            let loops = frames.contains { frame in
                guard case let .window(note, open) = frame, note == id, let open else { return false }
                return roots.contains(where: open.contains)
            }
            if loops { return .cycle }
        }
        return windowDepth >= Self.maxDepth ? .tooDeep : nil
    }
}
