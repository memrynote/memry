import SwiftUI
import UIKit

/// The scene drawn to fit the page's width, never above Excalidraw's own
/// scale, with Excalidraw's 10 point export padding.
struct WhiteboardPicture: View {
    let scene: WhiteboardScene

    @Environment(\.colorScheme) private var colorScheme

    private static let padding: CGFloat = 10
    private static let maxHeight: CGFloat = 420

    var body: some View {
        if let bounds = scene.bounds, bounds.width > 0 || bounds.height > 0 {
            let box = bounds.insetBy(dx: -Self.padding, dy: -Self.padding)
            GeometryReader { proxy in
                let scale = Self.scale(box, width: proxy.size.width)
                WhiteboardCanvas(scene: scene, box: box, scale: scale, dark: colorScheme == .dark)
                    .frame(width: box.width * scale, height: box.height * scale)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .aspectRatio(box.width / max(box.height, 1), contentMode: .fit)
            .frame(maxHeight: Self.maxHeight)
            .background(
                WhiteboardInk.color(scene.background, dark: colorScheme == .dark),
                in: .rect(cornerRadius: Tokens.Radius.card)
            )
            .clipShape(.rect(cornerRadius: Tokens.Radius.card))
            .overlay(RoundedRectangle(cornerRadius: Tokens.Radius.card).strokeBorder(Tokens.Line.border.color))
        } else {
            Text(WhiteboardCopy.empty)
                .font(Tokens.Typography.supporting.font)
                .foregroundStyle(Tokens.Text.secondary.color)
                .frame(maxWidth: .infinity, minHeight: Tokens.Size.minimumHitArea * 2)
                .overlay(RoundedRectangle(cornerRadius: Tokens.Radius.card).strokeBorder(Tokens.Line.border.color))
        }
    }

    private static func scale(_ box: CGRect, width: CGFloat) -> CGFloat {
        guard box.width > 0, box.height > 0 else { return 1 }
        return min(1, width / box.width, maxHeight / box.height)
    }
}

/// Excalidraw's colours, and its dark theme, which is the light picture
/// through `invert(93%) hue-rotate(180deg)`.
enum WhiteboardInk {
    static func color(_ css: String, dark: Bool) -> Color {
        guard let rgba = rgba(css, dark: dark) else { return .clear }
        return Color(.sRGB, red: rgba.r, green: rgba.g, blue: rgba.b, opacity: rgba.a)
    }

    static func rgba(_ css: String, dark: Bool) -> (r: Double, g: Double, b: Double, a: Double)? {
        guard let light = rgba(css) else { return nil }
        guard dark else { return light }
        let (r, g, b) = darkened(light.r, light.g, light.b)
        return (r, g, b, light.a)
    }

    private static func rgba(_ css: String) -> (r: Double, g: Double, b: Double, a: Double)? {
        let named: [String: String] = ["black": "#000000", "white": "#ffffff", "red": "#ff0000", "transparent": ""]
        var hex = (named[css.lowercased()] ?? css).trimmingCharacters(in: .whitespaces)
        guard hex.hasPrefix("#") else { return nil }
        hex.removeFirst()
        if hex.count == 3 || hex.count == 4 { hex = hex.map { "\($0)\($0)" }.joined() }
        guard hex.count == 6 || hex.count == 8, let value = UInt64(hex, radix: 16) else { return nil }
        let channels = hex.count == 8 ? value : value << 8 | 0xFF
        let channel = { (shift: UInt64) in Double((channels >> shift) & 0xFF) / 255 }
        return (channel(24), channel(16), channel(8), channel(0))
    }

    private static func darkened(_ r: Double, _ g: Double, _ b: Double) -> (Double, Double, Double) {
        let invert = { (value: Double) in 0.93 * (1 - value) + 0.07 * value }
        let (ir, ig, ib) = (invert(r), invert(g), invert(b))
        // `hue-rotate(180deg)`, the filter-effects matrix at cos -1, sin 0.
        let clamp = { (value: Double) in min(max(value, 0), 1) }
        return (
            clamp(-0.574 * ir + 1.430 * ig + 0.144 * ib),
            clamp(0.426 * ir + 0.430 * ig + 0.144 * ib),
            clamp(0.426 * ir + 1.430 * ig - 0.856 * ib)
        )
    }
}

private struct WhiteboardCanvas: View {
    let scene: WhiteboardScene
    let box: CGRect
    let scale: CGFloat
    let dark: Bool

    var body: some View {
        Canvas { context, _ in
            context.scaleBy(x: scale, y: scale)
            context.translateBy(x: -box.minX, y: -box.minY)
            for element in scene.elements {
                draw(element, in: context)
            }
        }
        .accessibilityHidden(true)
    }

    private func ink(_ css: String) -> Color { WhiteboardInk.color(css, dark: dark) }

    private func draw(_ element: WhiteboardScene.Element, in parent: GraphicsContext) {
        var context = parent
        context.opacity = element.opacity
        let frame = element.frame.standardized
        if element.angle != 0, !element.isLinear {
            context.translateBy(x: frame.midX, y: frame.midY)
            context.rotate(by: .radians(element.angle))
            context.translateBy(x: -frame.midX, y: -frame.midY)
        }
        let dash: [CGFloat] = switch element.stroke {
        case .solid: []
        case .dashed: [8, 8 + element.strokeWidth]
        case .dotted: [1.5, 6 + element.strokeWidth]
        }
        let style = StrokeStyle(lineWidth: element.strokeWidth, lineCap: .round, lineJoin: .round, dash: dash)
        switch element.kind {
        case .rectangle, .ellipse, .diamond, .other:
            let path = shape(element.kind, in: frame, rounded: element.rounded)
            fill(path, element.fill, in: context)
            context.stroke(path, with: .color(ink(element.ink)), style: style)
        case .frame, .magicframe:
            context.stroke(Path(roundedRect: frame, cornerRadius: 8), with: .color(ink("#bbb")), lineWidth: 1)
            if let name = element.name, !name.isEmpty {
                context.draw(
                    Text(name).font(.system(size: 14)).foregroundStyle(ink("#868e96")),
                    at: CGPoint(x: frame.minX, y: frame.minY - 4), anchor: .bottomLeading
                )
            }
        case .line, .arrow:
            let points = element.points.map { CGPoint(x: frame.minX + $0.x, y: frame.minY + $0.y) }
            var path = Path()
            path.addLines(points)
            if element.kind == .line, points.count > 2, points.first == points.last {
                fill(path, element.fill, in: context)
            }
            context.stroke(path, with: .color(ink(element.ink)), style: style)
            if points.count >= 2 {
                let solid = StrokeStyle(lineWidth: element.strokeWidth, lineCap: .round, lineJoin: .round)
                if element.endArrow {
                    context.stroke(arrowhead(at: points[points.count - 1], from: points[points.count - 2]), with: .color(ink(element.ink)), style: solid)
                }
                if element.startArrow {
                    context.stroke(arrowhead(at: points[0], from: points[1]), with: .color(ink(element.ink)), style: solid)
                }
            }
        case .freedraw:
            var path = Path()
            path.addLines(element.points.map { CGPoint(x: frame.minX + $0.x, y: frame.minY + $0.y) })
            context.stroke(path, with: .color(ink(element.ink)), style: StrokeStyle(lineWidth: element.strokeWidth * 1.5, lineCap: .round, lineJoin: .round))
        case .text:
            let lineHeight = element.fontSize * 1.25
            for (index, line) in element.text.components(separatedBy: "\n").enumerated() {
                let y = frame.minY + Double(index) * lineHeight
                let (x, anchor): (Double, UnitPoint) = switch element.textAlign {
                case "center": (frame.midX, .top)
                case "right": (frame.maxX, .topTrailing)
                default: (frame.minX, .topLeading)
                }
                context.draw(
                    Text(line).font(.system(size: element.fontSize)).foregroundStyle(ink(element.ink)),
                    at: CGPoint(x: x, y: y + (lineHeight - element.fontSize) / 2), anchor: anchor
                )
            }
        case .image:
            if let url = element.fileId.flatMap({ scene.inlineImages[$0] }), let image = WhiteboardImages.image(url) {
                context.draw(Image(uiImage: image).resizable(), in: frame)
            } else {
                let border = Path(roundedRect: frame, cornerRadius: 4)
                context.fill(border, with: .color(ink("#f1f3f5")))
                context.stroke(border, with: .color(ink("#adb5bd")), style: StrokeStyle(lineWidth: 1, dash: [4, 4]))
                context.draw(
                    Text(Image(systemName: "photo")) + Text(" \(WhiteboardCopy.image)"),
                    at: CGPoint(x: frame.midX, y: frame.midY)
                )
            }
        }
    }

    private func fill(_ path: Path, _ fill: WhiteboardScene.Element.Fill, in context: GraphicsContext) {
        switch fill {
        case .none: break
        case let .solid(color): context.fill(path, with: .color(ink(color)))
        case let .hatched(color): context.fill(path, with: .color(ink(color).opacity(0.45)))
        }
    }

    /// Excalidraw's corner: a quarter of the shorter side, at most 32.
    private func shape(_ kind: WhiteboardScene.Element.Kind, in frame: CGRect, rounded: Bool) -> Path {
        switch kind {
        case .ellipse:
            return Path(ellipseIn: frame)
        case .diamond:
            var path = Path()
            path.addLines([
                CGPoint(x: frame.midX, y: frame.minY), CGPoint(x: frame.maxX, y: frame.midY),
                CGPoint(x: frame.midX, y: frame.maxY), CGPoint(x: frame.minX, y: frame.midY),
            ])
            path.closeSubpath()
            return path
        default:
            let radius = rounded ? min(32, min(frame.width, frame.height) * 0.25) : 0
            return Path(roundedRect: frame, cornerRadius: radius)
        }
    }

    private func arrowhead(at tip: CGPoint, from previous: CGPoint) -> Path {
        let angle = atan2(tip.y - previous.y, tip.x - previous.x)
        let length = min(20, hypot(tip.x - previous.x, tip.y - previous.y) / 2)
        var path = Path()
        for side in [-1.0, 1.0] {
            let wing = angle + .pi - side * .pi / 7
            path.move(to: tip)
            path.addLine(to: CGPoint(x: tip.x + cos(wing) * length, y: tip.y + sin(wing) * length))
        }
        return path
    }
}

/// Decoded inline images, kept in memory only, like every other picture of a
/// note's content.
@MainActor
private enum WhiteboardImages {
    private static let cache = NSCache<NSString, UIImage>()

    static func image(_ dataURL: String) -> UIImage? {
        if let hit = cache.object(forKey: dataURL as NSString) { return hit }
        guard let comma = dataURL.firstIndex(of: ","),
              let data = Data(base64Encoded: String(dataURL[dataURL.index(after: comma)...])),
              let image = UIImage(data: data)
        else { return nil }
        cache.setObject(image, forKey: dataURL as NSString)
        return image
    }
}
