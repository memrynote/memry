import SwiftUI

/// One stored icon value (a bare emoji, desktop's `icon:<Name>`, `custom:<id>`
/// or a legacy lucide name), drawn the way desktop's `NoteIconDisplay` draws
/// it as far as the phone can (`render-note-icon.tsx`). An emoji draws as
/// itself. A `custom:<id>` image is not on the phone (the core reads
/// `custom_icon` records but keeps no copy), so it gets what desktop draws for
/// an icon it cannot load: an empty box one glyph wide. Any other value draws
/// the screen's `fallback` symbol, or nothing. Never shows the stored text.
struct StoredIconView: View {
    let value: String?
    var fallback: String?

    var body: some View {
        if let emoji = ProjectIconValue.emoji(value) {
            Text(emoji)
        } else if ProjectIconValue.isCustom(value) {
            Image(systemName: "square").hidden()
        } else if let fallback {
            Image(systemName: fallback)
        }
    }
}
