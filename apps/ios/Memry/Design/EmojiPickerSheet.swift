import Foundation
import SwiftUI

// The emoji picker, after desktop's `EmojiPicker` (Emoji tab): search, the
// same categories in the same order, and a Remove action when an icon is set.
//
// The emoji come from `Resources/emoji.json`, generated from the
// `@emoji-mart/data` set the desktop picker uses
// (`scripts/generate-ios-emoji-data.mjs`), so both offer the same glyphs.
//
// **Emoji only.** Desktop's Icons and Custom tabs write `icon:<name>` and
// `custom:<id>` values that need a name-to-glyph mapping or the vault's icon
// files to draw. This sheet never rewrites a value it does not offer: it only
// writes an emoji, or `nil` to clear.

/// One category of the picker: an id and its emoji with lowercase search text.
struct EmojiCategory: Identifiable, Equatable, Sendable {
    struct Entry: Equatable, Sendable {
        let emoji: String
        let searchText: String
    }

    let id: String
    let entries: [Entry]

    var title: String {
        switch id {
        case "people": "Smileys & people"
        case "nature": "Animals & nature"
        case "foods": "Food & drink"
        case "activity": "Activity"
        case "places": "Travel & places"
        case "objects": "Objects"
        case "symbols": "Symbols"
        case "flags": "Flags"
        default: id.capitalized
        }
    }

    var symbol: String {
        switch id {
        case "people": "face.smiling"
        case "nature": "leaf"
        case "foods": "fork.knife"
        case "activity": "figure.run"
        case "places": "airplane"
        case "objects": "lightbulb"
        case "symbols": "heart"
        case "flags": "flag"
        default: "circle"
        }
    }
}

enum EmojiCatalog {
    /// The bundled emoji, in desktop's category order. Empty when the resource
    /// is missing or unreadable, which the sheet shows as an empty grid rather
    /// than a crash.
    static func load(bundle: Bundle = .main) -> [EmojiCategory] {
        guard let url = bundle.url(forResource: "emoji", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let raw = try? JSONDecoder().decode([RawCategory].self, from: data)
        else {
            Log.interface.error("the emoji list could not be read")
            return []
        }
        return raw.map { category in
            EmojiCategory(
                id: category.id,
                entries: category.emojis.compactMap { pair in
                    pair.count == 2 ? EmojiCategory.Entry(emoji: pair[0], searchText: pair[1]) : nil
                }
            )
        }
    }

    /// The entries whose name or keywords contain every word typed.
    static func search(_ query: String, in categories: [EmojiCategory]) -> [String] {
        let words = query.lowercased().split(whereSeparator: \.isWhitespace).map(String.init)
        guard !words.isEmpty else { return [] }
        return categories.flatMap(\.entries)
            .filter { entry in words.allSatisfy { entry.searchText.contains($0) } }
            .map(\.emoji)
    }

    private struct RawCategory: Decodable {
        let id: String
        let emojis: [[String]]
    }
}

struct EmojiPickerSheet: View {
    /// The icon the item has now; a non-`nil` value enables Remove.
    let current: String?
    /// The chosen emoji, or `nil` for Remove.
    let choose: (String?) -> Void

    @State private var categories = EmojiCatalog.load()
    @State private var query = ""

    private let columns = [GridItem(.adaptive(minimum: 44), spacing: 0)]

    private var hasQuery: Bool { !query.trimmingCharacters(in: .whitespaces).isEmpty }

    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
                VStack(spacing: 0) {
                    ScrollView {
                        if hasQuery {
                            results
                        } else {
                            LazyVStack(alignment: .leading, spacing: Tokens.Space.medium, pinnedViews: []) {
                                ForEach(categories) { category in
                                    Text(category.title)
                                        .font(Tokens.Typography.caption.font)
                                        .foregroundStyle(Tokens.Text.secondary.color)
                                        .padding(.horizontal, Tokens.Space.screenInline)
                                        .id(category.id)
                                        .accessibilityAddTraits(.isHeader)
                                    grid(category.entries.map(\.emoji))
                                }
                            }
                            .padding(.vertical, Tokens.Space.medium)
                        }
                    }
                    .scrollDismissesKeyboard(.immediately)
                    if !hasQuery { categoryBar(proxy) }
                }
            }
            .navigationTitle("Icon")
            .navigationBarTitleDisplayMode(.inline)
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search emoji")
            .toolbar {
                // Clearing is the action a grid usually hides, and it is the
                // one a user most often wants back.
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Remove") { choose(nil) }
                        .disabled(current == nil)
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    @ViewBuilder
    private var results: some View {
        let found = EmojiCatalog.search(query, in: categories)
        if found.isEmpty {
            Text("No emoji match “\(query)”.")
                .font(Tokens.Typography.body.font)
                .foregroundStyle(Tokens.Text.secondary.color)
                .frame(maxWidth: .infinity)
                .padding(Tokens.Space.screenInline)
        } else {
            grid(found).padding(.vertical, Tokens.Space.medium)
        }
    }

    private func grid(_ emoji: [String]) -> some View {
        LazyVGrid(columns: columns, spacing: 0) {
            ForEach(emoji, id: \.self) { symbol in
                Button {
                    choose(symbol)
                } label: {
                    Text(symbol)
                        .font(.system(size: 28))
                        .frame(maxWidth: .infinity, minHeight: 44)
                        .background(symbol == current ? Tokens.Text.secondary.color.opacity(0.15) : .clear,
                                    in: RoundedRectangle(cornerRadius: 8))
                }
                .buttonStyle(.plain)
                .accessibilityLabel(symbol)
            }
        }
        .padding(.horizontal, Tokens.Space.small)
    }

    private func categoryBar(_ proxy: ScrollViewProxy) -> some View {
        HStack {
            ForEach(categories) { category in
                Button {
                    withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(category.id, anchor: .top) }
                } label: {
                    Image(systemName: category.symbol)
                        .frame(maxWidth: .infinity, minHeight: 44)
                }
                .accessibilityLabel(category.title)
            }
        }
        .foregroundStyle(Tokens.Text.secondary.color)
        .padding(.horizontal, Tokens.Space.small)
        .background(.bar)
    }
}
