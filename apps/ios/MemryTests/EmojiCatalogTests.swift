import Foundation
import Testing
@testable import Memry

@Suite("Emoji catalog")
struct EmojiCatalogTests {
    private let categories = [
        EmojiCategory(id: "nature", entries: [
            .init(emoji: "🌱", searchText: "seedling plant sprout"),
            .init(emoji: "🐱", searchText: "cat face pet"),
        ]),
        EmojiCategory(id: "foods", entries: [.init(emoji: "🍎", searchText: "red apple fruit")]),
    ]

    @Test("every typed word must match the name or keywords")
    func searchMatchesAllWords() {
        #expect(EmojiCatalog.search("plant", in: categories) == ["🌱"])
        #expect(EmojiCatalog.search("Red  fruit", in: categories) == ["🍎"])
        #expect(EmojiCatalog.search("cat apple", in: categories).isEmpty)
        #expect(EmojiCatalog.search("   ", in: categories).isEmpty)
    }

    @Test("the bundled list loads in desktop's category order")
    func bundledListLoads() {
        let loaded = EmojiCatalog.load()
        #expect(loaded.first?.id == "people")
        #expect(loaded.map(\.id).contains("flags"))
        #expect(loaded.flatMap(\.entries).count > 1500)
    }
}
