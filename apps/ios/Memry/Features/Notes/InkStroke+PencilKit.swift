import PencilKit
import UIKit

// `PKStroke` and Excalidraw's `freedraw`, both ways (#4378). The points are
// the stroke path's control points, so a stroke read back from the element it
// was written as is the same stroke.
//
// Width: Excalidraw draws a freedraw through perfect-freehand at
// `size = strokeWidth * 4.25` with sine easing, about 6 x `strokeWidth` wide at
// resting pressure, and PencilKit's point size is the ink's diameter. Force:
// UIKit's 1 is an average touch and Excalidraw's 0.5 a resting pressure. A
// touch with no force reading (a finger) rests at 0.5.

extension InkStroke {
    static let widthScale = 6.0

    private var isMarker: Bool { inkType == PKInk.InkType.marker.rawValue }
    /// A marker is translucent ink: Excalidraw draws it at half opacity.
    private var fullOpacity: Double { isMarker ? 50 : 100 }

    /// The parts of `stroke` that show, in scene coordinates. A pixel eraser
    /// leaves a stroke whole under a mask, which Excalidraw has no way to
    /// draw, so each visible run is a stroke of its own.
    static func visible(_ stroke: PKStroke, offset: CGPoint) -> [InkStroke] {
        guard stroke.mask != nil else { return [InkStroke(stroke, offset: offset)] }
        return stroke.maskedPathRanges.map { range in
            let inner = stride(from: range.lowerBound.rounded(.down) + 1, to: range.upperBound, by: 1)
            let points = ([range.lowerBound] + inner + [range.upperBound]).map { stroke.path.interpolatedPoint(at: $0) }
            let path = PKStrokePath(controlPoints: range.lowerBound == range.upperBound ? [points[0]] : points, creationDate: stroke.path.creationDate)
            return InkStroke(PKStroke(ink: stroke.ink, path: path, transform: stroke.transform), offset: offset)
        }
    }

    /// `stroke` in scene coordinates, mask ignored; `offset` is where the
    /// canvas's origin sits in the scene.
    init(_ stroke: PKStroke, offset: CGPoint) {
        let transform = stroke.transform
        let scale = sqrt(abs(transform.a * transform.d - transform.b * transform.c))
        let points = Array(stroke.path)
        let inkType = stroke.ink.inkType.rawValue
        var alpha: CGFloat = 1
        let color = Self.hex(stroke.ink.color, alpha: &alpha)
        self.init(
            points: points.map { point in
                let location = point.location.applying(transform)
                return InkScene.rounded(CGPoint(x: location.x + offset.x, y: location.y + offset.y))
            },
            pressures: points.map { point in
                ((point.force > 0 ? min(point.force / 2, 1) : 0.5) * 1000).rounded() / 1000
            },
            color: color,
            width: points.isEmpty ? 1 : (points.map(\.size.width).reduce(0, +) / Double(points.count) * scale / Self.widthScale * 100).rounded() / 100,
            opacity: 0,
            inkType: inkType,
            tilt: Self.tilt(points)
        )
        opacity = Int((alpha * fullOpacity).rounded())
    }

    private static func tilt(_ points: [PKStrokePoint]) -> InkTilt {
        guard !points.isEmpty else { return InkTilt() }
        let count = Double(points.count)
        let mean = { (value: (PKStrokePoint) -> CGFloat) in points.map { Double(value($0)) }.reduce(0, +) / count }
        let rounded = { (value: Double) in (value * 1000).rounded() / 1000 }
        // An angle's mean is the direction of its mean unit vector.
        return InkTilt(
            azimuth: rounded(atan2(mean { sin($0.azimuth) }, mean { cos($0.azimuth) })),
            altitude: rounded(mean(\.altitude)),
            opacity: rounded(mean(\.opacity))
        )
    }

    /// The stroke on a canvas whose origin sits at `offset` in the scene.
    /// `created` is the path's creation date, which the surface keys the
    /// stroke's element by.
    func stroke(created: Date, offset: CGPoint) -> PKStroke {
        let size = CGSize(width: width * Self.widthScale, height: width * Self.widthScale)
        let path = PKStrokePath(
            controlPoints: zip(points, pressures).enumerated().map { index, pair in
                PKStrokePoint(
                    location: CGPoint(x: pair.0.x - offset.x, y: pair.0.y - offset.y),
                    timeOffset: Double(index) / 120, size: size, opacity: tilt.opacity,
                    force: pair.1 * 2, azimuth: tilt.azimuth, altitude: tilt.altitude
                )
            },
            creationDate: created
        )
        let ink = PKInk(
            PKInk.InkType(rawValue: inkType) ?? .pen,
            color: Self.color(color, alpha: min(1, Double(opacity) / fullOpacity))
        )
        return PKStroke(ink: ink, path: path)
    }

    /// PencilKit keeps the light-appearance colour and adapts it on screen,
    /// as Excalidraw's dark theme does.
    private static func hex(_ color: UIColor, alpha: inout CGFloat) -> String {
        let light = color.resolvedColor(with: UITraitCollection(userInterfaceStyle: .light))
        var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0
        light.getRed(&red, green: &green, blue: &blue, alpha: &alpha)
        let byte = { (value: CGFloat) in Int((min(max(value, 0), 1) * 255).rounded()) }
        return String(format: "#%02x%02x%02x", byte(red), byte(green), byte(blue))
    }

    private static func color(_ css: String, alpha: Double) -> UIColor {
        guard let rgba = WhiteboardInk.rgba(css, dark: false) else { return UIColor(white: 0.12, alpha: alpha) }
        return UIColor(red: rgba.r, green: rgba.g, blue: rgba.b, alpha: rgba.a * alpha)
    }
}

/// Which stored element each stroke on the canvas is (#4378). PencilKit
/// strokes carry no id on iOS 26, so a stroke is known by its path's creation
/// date: strokes read from the scene get dates no live drawing has, and the
/// first stroke with a known date is that element. A lasso copy repeats a
/// date, and the copy is a new stroke.
struct InkLedger: Equatable {
    struct Entry: Equatable {
        let created: Double
        let id: String
        /// The stroke as last read or saved, to tell an edit from no change.
        let ink: InkStroke
    }

    private(set) var entries: [Entry] = []

    /// A date no drawn stroke has: before 2001, PencilKit's reference date.
    static func created(index: Int) -> Date { Date(timeIntervalSinceReferenceDate: -1_000_000 + Double(index)) }

    init(_ entries: [Entry] = []) { self.entries = entries }

    /// The edit that turns the ledger's strokes into `strokes`, and each
    /// stroke's element id, `nil` for one that is new.
    func diff(_ strokes: [(created: Double, ink: InkStroke)]) -> (edit: InkEdit, ids: [String?]) {
        var unused = entries
        var edit = InkEdit()
        var ids: [String?] = []
        for stroke in strokes {
            guard let index = unused.firstIndex(where: { $0.created == stroke.created }) else {
                edit.added.append(stroke.ink)
                ids.append(nil)
                continue
            }
            let entry = unused.remove(at: index)
            if entry.ink != stroke.ink { edit.changed[entry.id] = stroke.ink }
            ids.append(entry.id)
        }
        edit.erased = Set(unused.map(\.id))
        return (edit, ids)
    }

    /// The ledger once `strokes` are saved, the new ones under `addedIds`.
    mutating func commit(_ strokes: [(created: Double, ink: InkStroke)], ids: [String?], addedIds: [String]) {
        var added = addedIds.makeIterator()
        entries = zip(strokes, ids).compactMap { stroke, id in
            (id ?? added.next()).map { Entry(created: stroke.created, id: $0, ink: stroke.ink) }
        }
    }
}
