import CoreGraphics
import Foundation

// The drawing surface's half of a canvas scene (#4378): the Excalidraw
// `freedraw` elements it wrote, read back as strokes, and its edits written
// into the scene text. A drawing is stored as the whiteboard it sits in
// (decision Q11): no new block type and no new format, so desktop renders and
// edits it in Excalidraw unchanged.
//
// - **Own elements** carry `customData.memryInk: true`. Only they come back
//   as strokes, and only they are ever rewritten.
// - **Every other element keeps its bytes.** An edit splices the scene's
//   `elements` array: untouched elements are copied from the stored text, and
//   nothing outside the array changes.
// - **An erase is Excalidraw's**: `isDeleted: true` and a version bump, so a
//   desktop holding the element reconciles it as a delete.
// - **Edits apply to the scene as stored now**, not as it was opened, so a
//   desktop edit that synced in while the surface was open survives the save.

/// One stroke as Excalidraw stores it, in scene coordinates.
struct InkStroke: Equatable {
    /// Absolute, rounded to 0.01.
    var points: [CGPoint]
    /// 0 to 1, one per point; 0.5 is Excalidraw's resting pressure.
    var pressures: [Double]
    /// Light-theme CSS hex, Excalidraw's convention: its dark theme is a
    /// filter over the light colours (`WhiteboardInk`).
    var color: String
    /// Excalidraw's `strokeWidth`.
    var width: Double
    /// 0 to 100.
    var opacity: Int
    /// `PKInk.InkType`'s raw value, so a marker re-opens as a marker.
    var inkType: String
}

/// What the surface changed since the scene was last read or saved.
struct InkEdit: Equatable {
    var added: [InkStroke] = []
    var changed: [String: InkStroke] = [:]
    var erased: Set<String> = []

    var isEmpty: Bool { added.isEmpty && changed.isEmpty && erased.isEmpty }
}

/// The clock and randomness an edit stamps elements with; tests pin them.
struct InkStamp {
    var now: () -> Int = { Int(Date().timeIntervalSince1970 * 1000) }
    var random: () -> Int = { Int.random(in: 1 ... Int(Int32.max)) }
    var newId: () -> String = { UUID().uuidString.lowercased() }
}

enum InkScene {
    static let customKey = "memryInk"
    static let inkTypeKey = "inkType"
    static let defaultInk = "com.apple.ink.pen"
    /// Desktop's `EMPTY_SCENE`, what a blank scene stands for.
    static let emptyScene = #"{"type":"excalidraw","version":2,"source":"memry","elements":[],"appState":{},"files":{}}"#

    /// The live strokes this surface wrote, in paint order. `nil` when the
    /// scene is not an Excalidraw document.
    static func strokes(in scene: String) -> [(id: String, ink: InkStroke)]? {
        guard let document = Document(scene) else { return nil }
        return document.elements.compactMap { raw in
            guard let element = object(raw), let id = element["id"] as? String, let ink = stroke(element) else { return nil }
            return (id, ink)
        }
    }

    /// `scene` with `edit` applied, and the ids the added strokes got, in
    /// order. `nil` when the scene is not an Excalidraw document, which is
    /// never written over.
    static func apply(_ edit: InkEdit, to scene: String, stamp: InkStamp = InkStamp()) -> (scene: String, addedIds: [String])? {
        guard let document = Document(scene) else { return nil }
        guard !edit.isEmpty else { return (scene, []) }
        var pending = edit.changed
        var elements: [String] = []
        for raw in document.elements {
            guard let element = object(raw), let id = element["id"] as? String,
                  edit.erased.contains(id) || pending[id] != nil
            else {
                elements.append(raw)
                continue
            }
            if let ink = pending.removeValue(forKey: id) {
                // The iPad's edit wins, as a higher version does in
                // Excalidraw's reconcile: the ink stays rather than vanishing.
                elements.append(encode(freedraw(ink, over: element, stamp: stamp)))
            } else if element["isDeleted"] as? Bool == true {
                elements.append(raw)
            } else {
                var erased = element
                erased["isDeleted"] = true
                bump(&erased, stamp: stamp)
                elements.append(encode(erased))
            }
        }
        // A changed stroke whose element is gone from the stored scene is
        // written back rather than lost.
        for (id, ink) in pending.sorted(by: { $0.key < $1.key }) {
            elements.append(encode(freedraw(ink, over: ["id": id], stamp: stamp)))
        }
        var addedIds: [String] = []
        for ink in edit.added {
            let id = stamp.newId()
            addedIds.append(id)
            elements.append(encode(freedraw(ink, over: ["id": id], stamp: stamp)))
        }
        return (document.replacingElements(with: elements), addedIds)
    }

    // MARK: Elements

    /// An own, live freedraw element as a stroke. A rotation desktop gave it
    /// is applied to the points, about the element's centre.
    static func stroke(_ element: [String: Any]) -> InkStroke? {
        guard element["type"] as? String == "freedraw", element["isDeleted"] as? Bool != true,
              (element["customData"] as? [String: Any])?[customKey] as? Bool == true
        else { return nil }
        let number = { (key: String) in (element[key] as? NSNumber)?.doubleValue }
        let relative = (element["points"] as? [[Any]] ?? []).compactMap { pair -> CGPoint? in
            guard pair.count >= 2, let x = (pair[0] as? NSNumber)?.doubleValue,
                  let y = (pair[1] as? NSNumber)?.doubleValue else { return nil }
            return CGPoint(x: x, y: y)
        }
        guard !relative.isEmpty else { return nil }
        let origin = CGPoint(x: number("x") ?? 0, y: number("y") ?? 0)
        let angle = number("angle") ?? 0
        let xs = relative.map(\.x), ys = relative.map(\.y)
        let center = CGPoint(
            x: origin.x + ((xs.min() ?? 0) + (xs.max() ?? 0)) / 2,
            y: origin.y + ((ys.min() ?? 0) + (ys.max() ?? 0)) / 2
        )
        let points = relative.map { point -> CGPoint in
            let absolute = CGPoint(x: origin.x + point.x, y: origin.y + point.y)
            guard angle != 0 else { return rounded(absolute) }
            let dx = absolute.x - center.x, dy = absolute.y - center.y
            return rounded(CGPoint(
                x: center.x + dx * cos(angle) - dy * sin(angle),
                y: center.y + dx * sin(angle) + dy * cos(angle)
            ))
        }
        let pressures = (element["pressures"] as? [NSNumber])?.map(\.doubleValue) ?? []
        return InkStroke(
            points: points,
            pressures: pressures.count == points.count ? pressures : Array(repeating: 0.5, count: points.count),
            color: element["strokeColor"] as? String ?? "#1e1e1e",
            width: number("strokeWidth") ?? 1,
            opacity: Int((number("opacity") ?? 100).rounded()),
            inkType: (element["customData"] as? [String: Any])?[inkTypeKey] as? String ?? defaultInk
        )
    }

    /// `ink` as an Excalidraw 0.18 freedraw element over `base`: a new
    /// element's defaults, or the stored element's other keys (`index`,
    /// `groupIds`, `frameId`, `link`) kept as they are.
    private static func freedraw(_ ink: InkStroke, over base: [String: Any], stamp: InkStamp) -> [String: Any] {
        let first = ink.points.first ?? .zero
        let relative = ink.points.map { CGPoint(x: round($0.x - first.x), y: round($0.y - first.y)) }
        let xs = relative.map(\.x), ys = relative.map(\.y)
        let isNew = base["type"] == nil
        var element = base
        if isNew {
            element.merge([
                "type": "freedraw", "backgroundColor": "transparent", "fillStyle": "solid", "strokeStyle": "solid",
                "roughness": 1, "groupIds": [Any](), "frameId": NSNull(), "roundness": NSNull(), "seed": stamp.random(),
                "version": 0, "boundElements": NSNull(), "link": NSNull(), "locked": false,
            ]) { old, _ in old }
        }
        var custom = element["customData"] as? [String: Any] ?? [:]
        custom[customKey] = true
        custom[inkTypeKey] = ink.inkType
        element.merge([
            "x": round(first.x), "y": round(first.y),
            "width": (xs.max() ?? 0) - (xs.min() ?? 0), "height": (ys.max() ?? 0) - (ys.min() ?? 0),
            "angle": 0, "strokeColor": ink.color, "strokeWidth": ink.width, "opacity": ink.opacity,
            "points": relative.map { [$0.x, $0.y] }, "pressures": ink.pressures,
            "simulatePressure": false, "lastCommittedPoint": relative.last.map { [$0.x, $0.y] } ?? NSNull(),
            "isDeleted": false, "customData": custom,
        ]) { _, new in new }
        bump(&element, stamp: stamp)
        return element
    }

    private static func bump(_ element: inout [String: Any], stamp: InkStamp) {
        element["version"] = ((element["version"] as? NSNumber)?.intValue ?? 0) + 1
        element["versionNonce"] = stamp.random()
        element["updated"] = stamp.now()
    }

    static func rounded(_ point: CGPoint) -> CGPoint { CGPoint(x: round(point.x), y: round(point.y)) }
    private static func round(_ value: Double) -> Double { (value * 100).rounded() / 100 }

    private static func object(_ raw: String) -> [String: Any]? {
        raw.data(using: .utf8).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
    }

    private static func encode(_ element: [String: Any]) -> String {
        let data = (try? JSONSerialization.data(withJSONObject: element, options: [.sortedKeys, .withoutEscapingSlashes])) ?? Data()
        return String(decoding: data, as: UTF8.self)
    }
}

/// A scene's text with its `elements` array split into each element's own
/// text, so a write replaces the array and copies everything else.
private struct Document {
    let text: [UInt8]
    /// The array's span, brackets included; `nil` for a scene with no
    /// `elements` key.
    let span: Range<Int>?
    let elements: [String]
    /// Just after the top-level `{`, where a missing array goes.
    let openBrace: Int

    init?(_ scene: String) {
        let source = scene.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? InkScene.emptyScene : scene
        guard let data = source.data(using: .utf8),
              (try? JSONSerialization.jsonObject(with: data)) is [String: Any]
        else { return nil }
        let bytes = Array(source.utf8)
        var scanner = JSONScanner(bytes: bytes)
        scanner.skipSpace()
        guard scanner.take(UInt8(ascii: "{")) else { return nil }
        openBrace = scanner.index
        var span: Range<Int>?
        while scanner.skipSpace(), !scanner.take(UInt8(ascii: "}")) {
            _ = scanner.take(UInt8(ascii: ","))
            scanner.skipSpace()
            let keyStart = scanner.index
            scanner.skipValue()
            let key = String(decoding: bytes[keyStart ..< scanner.index], as: UTF8.self)
            scanner.skipSpace()
            guard scanner.take(UInt8(ascii: ":")) else { return nil }
            scanner.skipSpace()
            let valueStart = scanner.index
            scanner.skipValue()
            if key == #""elements""#, span == nil { span = valueStart ..< scanner.index }
        }
        var elements: [String] = []
        if let span, bytes[span.lowerBound] == UInt8(ascii: "[") {
            var inner = JSONScanner(bytes: bytes, index: span.lowerBound + 1)
            while inner.skipSpace(), inner.index < span.upperBound - 1 {
                _ = inner.take(UInt8(ascii: ","))
                inner.skipSpace()
                let start = inner.index
                guard start < span.upperBound - 1 else { break }
                inner.skipValue()
                elements.append(String(decoding: bytes[start ..< inner.index], as: UTF8.self))
            }
        }
        self.text = bytes
        self.span = span
        self.elements = elements
    }

    func replacingElements(with elements: [String]) -> String {
        let array = Array("[\(elements.joined(separator: ","))]".utf8)
        var out = text
        if let span {
            out.replaceSubrange(span, with: array)
        } else {
            let hasKeys = text[openBrace...].contains { !" \n\r\t}".utf8.contains($0) }
            out.insert(contentsOf: Array(#""elements":"#.utf8) + array + (hasKeys ? [UInt8(ascii: ",")] : []), at: openBrace)
        }
        return String(decoding: out, as: UTF8.self)
    }
}

/// Just enough of a JSON reader to step over values in text already known
/// to be valid JSON.
private struct JSONScanner {
    let bytes: [UInt8]
    var index = 0

    @discardableResult
    mutating func skipSpace() -> Bool {
        while index < bytes.count, " \n\r\t".utf8.contains(bytes[index]) { index += 1 }
        return index < bytes.count
    }

    mutating func take(_ byte: UInt8) -> Bool {
        guard index < bytes.count, bytes[index] == byte else { return false }
        index += 1
        return true
    }

    mutating func skipValue() {
        guard index < bytes.count else { return }
        switch bytes[index] {
        case UInt8(ascii: "\""):
            skipString()
        case UInt8(ascii: "{"), UInt8(ascii: "["):
            var depth = 0
            repeat {
                switch bytes[index] {
                case UInt8(ascii: "\""): skipString(); continue
                case UInt8(ascii: "{"), UInt8(ascii: "["): depth += 1
                case UInt8(ascii: "}"), UInt8(ascii: "]"): depth -= 1
                default: break
                }
                index += 1
            } while depth > 0 && index < bytes.count
        default:
            while index < bytes.count, !",}] \n\r\t".utf8.contains(bytes[index]) { index += 1 }
        }
    }

    private mutating func skipString() {
        index += 1
        while index < bytes.count, bytes[index] != UInt8(ascii: "\"") {
            index += bytes[index] == UInt8(ascii: "\\") ? 2 : 1
        }
        index += 1
    }
}
