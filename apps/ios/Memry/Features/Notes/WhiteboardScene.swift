import CoreGraphics
import Foundation

// A canvas's Excalidraw scene as the inline preview draws it: the live
// elements, in paint order, with only the fields a picture needs. The scene
// text itself is never rewritten here; the editor hands Excalidraw the stored
// bytes, so what this model leaves out is not lost.
//
// `nil` from `init(json:)` is desktop's `unreadable`: a canvas whose scene is
// not an Excalidraw document must not open in an editor, whose first save
// would write an empty board over ink that is still recoverable.

struct WhiteboardScene: Equatable {
    struct Element: Equatable {
        enum Kind: String {
            case rectangle, ellipse, diamond, line, arrow, freedraw, text, image, frame, magicframe
            /// Anything newer than this build knows (embeddable, iframe, ...),
            /// drawn as its outline.
            case other
        }

        enum Fill: Equatable {
            case none
            case solid(String)
            /// Hachure, cross-hatch and zigzag: Excalidraw's hand-drawn lines,
            /// drawn here as a lighter wash of the same colour.
            case hatched(String)
        }

        enum Stroke: String {
            case solid, dashed, dotted
        }

        let id: String
        let kind: Kind
        let frame: CGRect
        /// Radians, about the element's centre.
        let angle: Double
        let ink: String
        let fill: Fill
        let strokeWidth: Double
        let stroke: Stroke
        /// 0 to 1.
        let opacity: Double
        /// Rounded corners (`roundness` set).
        let rounded: Bool
        /// Line, arrow and freedraw points, relative to `frame.origin`.
        let points: [CGPoint]
        let startArrow: Bool
        let endArrow: Bool
        let text: String
        let fontSize: Double
        let textAlign: String
        /// A frame's name, drawn above it.
        let name: String?
        /// An image's file id, the key into `files`.
        let fileId: String?
    }

    let elements: [Element]
    let background: String
    /// Inline `data:` images by file id. Externalized ones (`memry-file://`)
    /// live on desktop's disk and draw as a named placeholder.
    let inlineImages: [String: String]

    init?(json: String) {
        let trimmed = json.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            self.init(elements: [], background: "#ffffff", inlineImages: [:])
            return
        }
        guard let data = trimmed.data(using: .utf8),
              let scene = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        else { return nil }
        let rawElements = scene["elements"] ?? []
        guard let list = rawElements as? [Any] else { return nil }
        let appState = scene["appState"] as? [String: Any]
        let files = scene["files"] as? [String: Any] ?? [:]
        var inline: [String: String] = [:]
        for (id, file) in files {
            if let url = (file as? [String: Any])?["dataURL"] as? String, url.hasPrefix("data:image/") {
                inline[id] = url
            }
        }
        self.init(
            elements: list.compactMap { ($0 as? [String: Any]).flatMap(Self.element) },
            background: appState?["viewBackgroundColor"] as? String ?? "#ffffff",
            inlineImages: inline
        )
    }

    private init(elements: [Element], background: String, inlineImages: [String: String]) {
        self.elements = elements
        self.background = background
        self.inlineImages = inlineImages
    }

    /// Excalidraw's `getCommonBounds` for unrotated elements: the box every
    /// element's shape, or every point of a line, sits in. `nil` for a board
    /// with nothing on it.
    var bounds: CGRect? {
        elements.map(\.bounds).reduce(nil) { $0?.union($1) ?? $1 }
    }

    private static func element(_ raw: [String: Any]) -> Element? {
        guard let id = raw["id"] as? String, let type = raw["type"] as? String,
              (raw["isDeleted"] as? Bool) != true
        else { return nil }
        let number = { (key: String) in (raw[key] as? NSNumber)?.doubleValue }
        let points = (raw["points"] as? [[Any]] ?? []).compactMap { pair -> CGPoint? in
            guard pair.count >= 2, let x = (pair[0] as? NSNumber)?.doubleValue,
                  let y = (pair[1] as? NSNumber)?.doubleValue else { return nil }
            return CGPoint(x: x, y: y)
        }
        let background = raw["backgroundColor"] as? String ?? "transparent"
        let fill: Element.Fill = if background == "transparent" || background.isEmpty {
            .none
        } else if (raw["fillStyle"] as? String ?? "solid") == "solid" {
            .solid(background)
        } else {
            .hatched(background)
        }
        return Element(
            id: id,
            kind: Element.Kind(rawValue: type) ?? .other,
            frame: CGRect(x: number("x") ?? 0, y: number("y") ?? 0, width: number("width") ?? 0, height: number("height") ?? 0),
            angle: number("angle") ?? 0,
            ink: raw["strokeColor"] as? String ?? "#1e1e1e",
            fill: fill,
            strokeWidth: number("strokeWidth") ?? 2,
            stroke: (raw["strokeStyle"] as? String).flatMap(Element.Stroke.init) ?? .solid,
            opacity: (number("opacity") ?? 100) / 100,
            rounded: raw["roundness"] is [String: Any],
            points: points,
            startArrow: raw["startArrowhead"] is String,
            endArrow: raw["endArrowhead"] is String,
            text: raw["text"] as? String ?? "",
            fontSize: number("fontSize") ?? 20,
            textAlign: raw["textAlign"] as? String ?? "left",
            name: raw["name"] as? String,
            fileId: raw["fileId"] as? String
        )
    }
}

extension WhiteboardScene.Element {
    var isLinear: Bool { kind == .line || kind == .arrow || kind == .freedraw }

    var bounds: CGRect {
        guard isLinear, !points.isEmpty else { return frame.standardized }
        let xs = points.map(\.x), ys = points.map(\.y)
        let minX = xs.min() ?? 0, minY = ys.min() ?? 0
        return CGRect(
            x: frame.minX + minX, y: frame.minY + minY,
            width: (xs.max() ?? 0) - minX, height: (ys.max() ?? 0) - minY
        )
    }
}
