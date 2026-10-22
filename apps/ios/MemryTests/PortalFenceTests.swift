import Testing

@testable import Memry

// Portal fences and the cycle/depth guard: what a reader of `memry-portal`
// sees for the definitions §12.6.3 allows, and for the ones it must survive.

struct PortalFenceTests {
    @Test func noteTargetByIdWithHiddenAnchorsCounted() {
        let fence = PortalFence(text: #"{"note":"n1","hidden":["b9x1","Bad","x"]}"#)
        #expect(fence.target == .note(id: "n1"))
        #expect(fence.hiddenCount == 1)
    }

    @Test func blockTargetNeedsAValidAnchor() {
        #expect(PortalFence(text: #"{"note":"n1","block":"chl-7f2a"}"#).target == .block(id: "n1", anchor: "chl-7f2a"))
        #expect(PortalFence(text: #"{"note":"n1","block":"-bad"}"#).target == .note(id: "n1"))
    }

    @Test func searchTargetNeedsTextOrTag() {
        #expect(PortalFence(text: #"{"search":{"text":"exam","tag":"bio","limit":50}}"#).target
            == .search(text: "exam", tag: "bio"))
        #expect(PortalFence(text: #"{"search":{"limit":5}}"#).target == nil)
    }

    @Test func unreadableDefinitionsHaveNoTarget() {
        for text in ["", "not json", "[]", #"{"note":""}"#, #"{"other":1}"#] {
            #expect(PortalFence(text: text).target == nil)
        }
    }

    @Test func unknownKeysDoNotHideTheTarget() {
        #expect(PortalFence(text: #"{"note":"n1","future":{"a":1}}"#).target == .note(id: "n1"))
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
        let target = PortalTarget.block(id: "host", anchor: "abcd")
        #expect(host.refusal(for: target) == nil)
        #expect(host.descending(into: target).withHost("host").refusal(for: target) == .cycle)
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
}
