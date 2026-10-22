import MemryCore
import Testing

@testable import Memry

// Portal fences and the cycle/depth guard: what a reader of `memry-portal`
// sees for the definitions §12.6.3 allows, and for the ones it must survive.

struct PortalFenceTests {
    // Definitions from packages/contracts/test-vectors/portal-resolve.json.
    // Resolution is the core's (crates/memry-core/tests/portal_vectors.rs);
    // the shell only names the target.
    @Test func noteTargetWhenBlocksAreAbsentOrEmpty() {
        #expect(PortalFence(text: #"{"v":1,"note":"n1"}"#).target == .note(id: "n1"))
        #expect(PortalFence(text: #"{"v":1,"note":"n1","blocks":[]}"#).target == .note(id: "n1"))
    }

    @Test func blocksTargetKeepsRootsInOrderAndReadsAbsentVAsOne() {
        #expect(PortalFence(text: #"{"v":1,"note":"n1","blocks":["sib1","ch02"]}"#).target
            == .blocks(id: "n1", roots: ["sib1", "ch02"]))
        #expect(PortalFence(text: #"{"note":"n1","blocks":["par1"]}"#).target == .blocks(id: "n1", roots: ["par1"]))
    }

    @Test func openStateAndUnknownKeysDoNotChangeTheTarget() {
        let text = #"{"v":1,"note":"n1","blocks":["par1"],"open":{"par1":{"show":["ch02"]}},"layout":{"future":true}}"#
        #expect(PortalFence(text: text).target == .blocks(id: "n1", roots: ["par1"]))
    }

    @Test func rootsThatAreNotAnchorsAreDroppedAndRepeatsCollapse() {
        #expect(PortalFence(text: #"{"note":"n1","blocks":["par1","Bad","x","par1",7]}"#).target
            == .blocks(id: "n1", roots: ["par1"]))
        #expect(PortalFence(text: #"{"note":"n1","blocks":["Bad"]}"#).target == .note(id: "n1"))
    }

    @Test func oldHiddenAndBlockKeysAreIgnored() {
        #expect(PortalFence(text: #"{"note":"n1","block":"chl-7f2a","hidden":["b9x1"]}"#).target == .note(id: "n1"))
    }

    @Test func searchTargetNeedsTextOrTag() {
        #expect(PortalFence(text: #"{"v":1,"search":{"text":"exam","tag":"bio","limit":50}}"#).target
            == .search(text: "exam", tag: "bio"))
        #expect(PortalFence(text: #"{"search":{"limit":5}}"#).target == nil)
        #expect(PortalFence(text: #"{"search":{"limit":5},"note":"n1"}"#).target == nil)
    }

    @Test func unreadableDefinitionsHaveNoTarget() {
        for text in ["", "not json", "[]", #"{"note":""}"#, #"{"note":"  "}"#, #"{"other":1}"#] {
            #expect(PortalFence(text: text).target == nil)
        }
    }

    @Test func anchorGrammar() {
        #expect(PortalFence.isAnchor("abcd"))
        #expect(PortalFence.isAnchor("a-b-1"))
        #expect(!PortalFence.isAnchor("abc"))
        #expect(!PortalFence.isAnchor("Abcd"))
        #expect(!PortalFence.isAnchor("-abc"))
        #expect(!PortalFence.isAnchor(String(repeating: "a", count: 33)))
    }

    @Test func noteTargetLoopsAgainstAnyFrameOnThatNote() {
        let ancestry = PortalAncestry().withHost("host")
        #expect(ancestry.refusal(for: .note(id: "host")) == .cycle)
        #expect(ancestry.refusal(for: .note(id: "other")) == nil)
    }

    @Test func blockOfTheHostNoteIsAllowedUntilItsWindowRepeats() {
        let host = PortalAncestry().withHost("host")
        let target = PortalTarget.blocks(id: "host", roots: ["abcd"])
        #expect(host.refusal(for: target) == nil)
        #expect(host.descending(into: target).withHost("host").refusal(for: target) == .cycle)
    }

    @Test func blocksTargetLoopsOnlyWhenAWindowSharesARoot() {
        let inside = PortalAncestry().descending(into: .blocks(id: "a", roots: ["par1", "sib1"]))
        #expect(inside.refusal(for: .blocks(id: "a", roots: ["sib1", "zzzz"])) == .cycle)
        #expect(inside.refusal(for: .blocks(id: "a", roots: ["other"])) == nil)
        #expect(inside.refusal(for: .note(id: "a")) == .cycle)
        let whole = PortalAncestry().descending(into: .note(id: "a"))
        #expect(whole.refusal(for: .blocks(id: "a", roots: ["par1"])) == nil)
    }

    @Test func hostFrameIsNotRepeatedInsideItsOwnWindow() {
        let inside = PortalAncestry().descending(into: .note(id: "a")).withHost("a")
        #expect(inside.frames.count == 1)
    }

    @Test func windowsStopAtThreeLevels() {
        var ancestry = PortalAncestry().withHost("host")
        for id in ["a", "b", "c"] {
            #expect(ancestry.refusal(for: .note(id: id)) == nil)
            ancestry = ancestry.descending(into: .note(id: id))
        }
        #expect(ancestry.windowDepth == PortalAncestry.maxDepth)
        #expect(ancestry.refusal(for: .note(id: "d")) == .tooDeep)
        #expect(ancestry.refusal(for: .note(id: "a")) == .cycle)
    }

    @Test func searchNeverDescendsOrRefuses() {
        let ancestry = PortalAncestry().withHost("host")
        #expect(ancestry.descending(into: .search(text: "x", tag: nil)) == ancestry)
        #expect(ancestry.refusal(for: .search(text: "x", tag: nil)) == nil)
    }

    // MARK: anchors are not drawn

    private func run(_ text: String, marks: [String] = []) -> InlineRun {
        InlineRun(text: text, marks: marks, markAttrs: [:], target: nil)
    }

    private func shown(_ runs: [InlineRun]) -> String { PortalAnchor.stripped(runs).map(\.text).joined() }

    @Test func trailingAnchorIsHidden() {
        #expect(shown([run("Parent ^par1")]) == "Parent")
        #expect(shown([run("Parent ^par1  ")]) == "Parent")
        #expect(shown([run("^par1")]) == "")
    }

    @Test func anchorAcrossInlineRunsIsHiddenAndMarksKept() {
        let runs = PortalAnchor.stripped([run("Bold ", marks: ["bold"]), run("tail ^ru"), run("n01")])
        #expect(runs.map(\.text) == ["Bold ", "tail"])
        #expect(runs.first?.marks == ["bold"])
    }

    @Test func midLineAndInWordCaretsAreText() {
        #expect(shown([run("Mid ^mid1 more")]) == "Mid ^mid1 more")
        #expect(shown([run("glue^glue1")]) == "glue^glue1")
        #expect(shown([run("x ^abc")]) == "x ^abc")
    }
}
