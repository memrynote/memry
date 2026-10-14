import SwiftUI
import Testing
import UIKit

@testable import Memry

// #2599: screens drew desktop's `custom:<id>` and `icon:<Name>` values as
// text. Rendered to pixels so the check is what the user sees.

@MainActor
private func pixels(_ view: some View) -> [UInt8] {
    let renderer = ImageRenderer(content: view.font(.body).frame(width: 120, height: 40).background(Color.white))
    renderer.scale = 1
    guard let image = renderer.cgImage else { return [] }
    var bytes = [UInt8](repeating: 0, count: 120 * 40 * 4)
    bytes.withUnsafeMutableBytes { buffer in
        let context = CGContext(
            data: buffer.baseAddress, width: 120, height: 40, bitsPerComponent: 8, bytesPerRow: 120 * 4,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        )
        context?.draw(image, in: CGRect(x: 0, y: 0, width: 120, height: 40))
    }
    return bytes
}

@MainActor
@Suite("Stored icon values draw as icons, never as their text", .serialized)
struct StoredIconViewTests {
    // An opaque background makes every render draw: an empty one otherwise
    // hands back the previous render's pixels.
    @Test func a_custom_icon_draws_an_empty_box() {
        #expect(pixels(StoredIconView(value: "custom:i4D0i_NKqVZr0a9eb-6B3")) == pixels(EmptyView()))
        #expect(pixels(StoredIconView(value: "custom:i4D0i_NKqVZr0a9eb-6B3", fallback: "doc.text"))
             == pixels(EmptyView()))
    }

    @Test(arguments: ["icon:StarIcon", "Folder"])
    func a_library_or_lucide_icon_draws_the_fallback(stored: String) {
        let drawn = pixels(StoredIconView(value: stored, fallback: "doc.text"))
        #expect(drawn == pixels(Image(systemName: "doc.text")))
        #expect(pixels(StoredIconView(value: stored)) == pixels(EmptyView()))
    }

    @Test func an_emoji_draws_itself() {
        #expect(pixels(StoredIconView(value: "🚀", fallback: "doc.text")) == pixels(Text("🚀")))
    }
}
