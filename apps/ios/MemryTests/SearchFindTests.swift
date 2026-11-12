import MemryCore
import Testing

@testable import Memry

// #4317: a note or journal hit opens its page with find on the query, scrolled
// to the first block holding it, once.

private func block(_ text: String) -> Block {
    Block(id: nil, kind: "paragraph", depth: 0, props: [],
          inline: [InlineRun(text: text, marks: [], markAttrs: [:], target: nil)])
}

@MainActor
@Suite("Search opens find")
struct SearchFindTests {
    @Test func opening_a_hit_carries_the_query_into_find_on_its_page_once() {
        let requests = SearchFindRequests()
        requests.open(.note("n1"), query: "  zephyrquartz ")

        #expect(requests.take(for: .note("n2")) == nil)
        #expect(requests.take(for: .journalDay("n1")) == nil)
        let query = requests.take(for: .note("n1"))
        #expect(query == "zephyrquartz")
        #expect(requests.take(for: .note("n1")) == nil)

        let blocks = [block("Bank password rotates monthly."), block("A ZephyrQuartz marker.")]
        #expect(SearchFindOpening.resolve(query ?? "", in: blocks) == .find(query: "zephyrquartz", blockIndex: 1))
    }

    @Test func a_query_no_block_holds_literally_opens_at_the_top_without_find() {
        let blocks = [block("Bank password rotates monthly.")]

        #expect(SearchFindOpening.resolve("bank monthly", in: blocks) == .top)
        // Blocks not read yet: the page keeps the query until they are.
        #expect(SearchFindOpening.resolve("bank", in: []) == .waiting)
    }
}
