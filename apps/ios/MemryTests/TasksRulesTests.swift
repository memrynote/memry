import Foundation
import MemryCore
import Testing

@testable import Memry

// The advanced filter over the real core: the rules narrow the page, a saved
// filter keeps them byte for byte (rules and keys this build does not know
// included), and opening the builder does not change the list.

@MainActor
@Suite("Tasks advanced filter", .serialized)
struct TasksRulesTests {
    private static func node(_ json: String) throws -> TaskFilterNode {
        try TaskFilterNode(json: #require(FilterJSON.decode(json)))
    }

    @Test func rules_narrow_the_page_through_the_core() async throws {
        let vault = try TasksTestVault()
        let project = try vault.project()
        let high = try vault.task("[agent] high", project: project, priority: 3)
        _ = try vault.task("[agent] low", project: project, priority: 1)
        let urgent = try vault.task("[agent] urgent", project: project, priority: 4)
        await vault.store.load()

        let rules = try Self.node("""
        {"match":"all","rules":[
          {"field":"title","op":"contains","values":["agent"]},
          {"match":"none","rules":[{"field":"priority","op":"any","values":["low"]}]},
          {"field":"tags","op":"any","values":[]}
        ]}
        """)
        await vault.store.updateFilters { $0.expression = rules }

        #expect(Set(vault.store.result?.taskIds ?? []) == [high, urgent])
        // The empty tags rule is skipped, not counted.
        #expect(vault.store.ruleCount == 2)
    }

    @Test func a_saved_filter_keeps_its_rules_verbatim_through_save_star_and_apply() async throws {
        let vault = try TasksTestVault()
        await vault.store.load()
        let rules = try Self.node("""
        {"match":"any","rules":[
          {"field":"priority","op":"any","values":["urgent"],"future":{"weight":2}},
          {"field":"mood","op":"is","values":["calm"]}
        ],"label":"from a newer build"}
        """)
        await vault.store.updateFilters { $0.expression = rules }

        #expect(await vault.store.saveCurrentFilter(name: "Rules"))
        var saved = try #require(vault.store.savedFilters.first { $0.name == "Rules" })
        #expect(FilterJSON.decode(saved.expressionJson) == rules.json)
        #expect(!saved.configJson.contains("expression"))

        await vault.store.toggleSavedFilterStar(saved)
        saved = try #require(vault.store.savedFilters.first { $0.name == "Rules" })
        #expect(saved.starred)
        #expect(FilterJSON.decode(saved.expressionJson) == rules.json)

        await vault.store.clearFilters()
        #expect(vault.store.state.filters.expression == nil)
        await vault.store.applySavedFilter(saved)
        #expect(vault.store.state.filters.expression == rules)
    }

    @Test func editing_one_rule_leaves_the_others_untouched() throws {
        let rules = try Self.node("""
        {"match":"all","rules":[
          {"field":"mood","op":"is","values":["calm"]},
          {"field":"priority","op":"any","values":["high"],"future":true}
        ]}
        """)
        let edited = try #require(rules.updating(at: [1]) { node in
            var copy = node
            copy.values = ["urgent"]
            return copy
        })
        let expected = try Self.node("""
        {"match":"all","rules":[
          {"field":"mood","op":"is","values":["calm"]},
          {"field":"priority","op":"any","values":["urgent"],"future":true}
        ]}
        """)
        #expect(edited == expected)
    }

    @Test func opening_the_builder_moves_chips_into_rules_and_keeps_the_list() async throws {
        let vault = try TasksTestVault()
        let project = try vault.project()
        _ = try vault.task("[agent] high", project: project, priority: 3)
        _ = try vault.task("[agent] low", project: project, priority: 1)
        await vault.store.load()
        await vault.store.updateFilters {
            $0.priorities = ["high"]
            $0.repeatType = "one-time"
        }
        let before = vault.store.result?.taskIds

        await vault.store.beginRuleEditing()

        #expect(vault.store.state.filters.priorities.isEmpty)
        #expect(vault.store.state.filters.repeatType == "all")
        #expect(vault.store.state.filters.expression?.rules.count == 2)
        #expect(vault.store.result?.taskIds == before)
    }
}
