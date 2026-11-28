import MemryCore
import SwiftUI
import Testing
import UIKit

@testable import Memry

// A tag chip paints its hue at `chipFillAlpha` as the fill. Lemon's own hue on
// that fill is about 1.7:1 in light, so the label is `Tokens.Palette.label(on:)`
// (desktop's `tagTextOnLight`). These measure the shipped dynamic colour.
@Suite("Tag chip label")
struct TagChipLabelTests {
    /// WCAG AA for ordinary text.
    private static let readable = 4.5

    private static let lightSurfaces: [(String, AdaptiveColor.RGB)] = [
        ("canvas", Tokens.Canvas.background.light),
        ("surface", Tokens.Canvas.surface.light),
        ("surfaceActive", Tokens.Canvas.surfaceActive.light)
    ]

    private static func rgb(_ color: Color, _ style: UIUserInterfaceStyle) -> AdaptiveColor.RGB {
        var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
        UIColor(color).resolvedColor(with: UITraitCollection(userInterfaceStyle: style))
            .getRed(&red, green: &green, blue: &blue, alpha: &alpha)
        return AdaptiveColor.RGB(red: red, green: green, blue: blue)
    }

    /// Every palette colour, plus a custom colour as pale as one gets.
    @Test("The label reads on the chip's fill over every light surface", arguments: Tokens.Palette.names + ["#ffff00"])
    func readsInLight(value: String) {
        let hue = Tokens.Palette.color(value)
        let label = Self.rgb(Tokens.Palette.label(on: hue), .light)
        let raw = Self.rgb(hue, .light)
        let alpha = Tokens.Palette.chipFillAlpha
        let mix = { (top: Double, under: Double) in top * alpha + under * (1 - alpha) }
        for (surfaceName, under) in Self.lightSurfaces {
            let fill = AdaptiveColor.RGB(
                red: mix(raw.red, under.red), green: mix(raw.green, under.green), blue: mix(raw.blue, under.blue)
            )
            let ratio = AdaptiveColor.RGB.contrast(label, fill)
            #expect(ratio >= Self.readable, "\(value) label on its fill over \(surfaceName) is \(ratio)")
        }
    }

    /// The editor's `hashTag` pill is a picture inside a TextKit 1 text view.
    /// Drawn the way the text view draws it, under each interface style, its
    /// label must change with the style and read in light.
    @Test("The editor's tag pill draws the label for the style it is drawn in")
    @MainActor
    func editorPillFollowsStyle() throws {
        let run = InlineRun(text: "", marks: ["hashTag"], markAttrs: ["hashTag.color": "lemon"], target: "lemon")
        let style = BlockText.Style(font: .systemFont(ofSize: 17), ink: .label, titleExists: nil)
        let storage = NSTextStorage(attributedString: BlockText.attributed([run], style: style))
        let manager = NSLayoutManager()
        let container = NSTextContainer(size: CGSize(width: 300, height: 60))
        manager.addTextContainer(container)
        storage.addLayoutManager(manager)
        func pixels(_ interface: UIUserInterfaceStyle) -> [AdaptiveColor.RGB] {
            let (width, height) = (300, 60)
            var bytes = [UInt8](repeating: 255, count: width * height * 4)
            bytes.withUnsafeMutableBytes { buffer in
                let context = CGContext(
                    data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8,
                    bytesPerRow: width * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                    bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
                )!
                context.translateBy(x: 0, y: CGFloat(height))
                context.scaleBy(x: 1, y: -1)
                UIGraphicsPushContext(context)
                UITraitCollection(userInterfaceStyle: interface).performAsCurrent {
                    manager.drawGlyphs(forGlyphRange: manager.glyphRange(for: container), at: CGPoint(x: 0, y: 20))
                }
                UIGraphicsPopContext()
            }
            return stride(from: 0, to: bytes.count, by: 4).map {
                AdaptiveColor.RGB(
                    red: Double(bytes[$0]) / 255, green: Double(bytes[$0 + 1]) / 255, blue: Double(bytes[$0 + 2]) / 255
                )
            }
        }
        let light = pixels(.light)
        let dark = pixels(.dark)
        #expect(light != dark)
        let ink = try #require(light.min { $0.relativeLuminance < $1.relativeLuminance })
        // The bitmap starts white, so the pill's fill is lemon at 12% over white.
        let white = AdaptiveColor.RGB(hex: 0xFF_FF_FF)
        let raw = Self.rgb(Tokens.Palette.color("lemon"), .light)
        let alpha = Tokens.Palette.chipFillAlpha
        let pill = AdaptiveColor.RGB(
            red: raw.red * alpha + white.red * (1 - alpha), green: raw.green * alpha + white.green * (1 - alpha),
            blue: raw.blue * alpha + white.blue * (1 - alpha)
        )
        #expect(AdaptiveColor.RGB.contrast(ink, pill) >= Self.readable)
    }

    /// Dark keeps the hue itself, as desktop does.
    @Test("The label in dark is the hue itself")
    func keepsHueInDark() {
        let hue = Tokens.Palette.color("lemon")
        let label = Self.rgb(Tokens.Palette.label(on: hue), .dark)
        #expect(label == Self.rgb(hue, .dark))
        #expect(label != Self.rgb(Tokens.Palette.label(on: hue), .light))
    }
}
