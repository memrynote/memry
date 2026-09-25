import Foundation
import MemryCore
import Testing

// Spec 006 IB014: `inbox.json` through the FFI. The expectations are the
// committed values generated from desktop's schema and handler rules; the
// actual values come out of `MemryCore`'s conformance seam (`inboxConformance`),
// which runs the vector's payloads through the same apply path a pull uses and
// answers the same reads `Inbox` does. Nothing here computes an expectation.

private final class InboxVectorsMarker {}

private enum InboxVectors {
    static func raw() -> String {
        guard
            let url = Bundle(for: InboxVectorsMarker.self)
                .url(forResource: "inbox", withExtension: "json", subdirectory: "test-vectors"),
            let text = try? String(contentsOf: url, encoding: .utf8)
        else {
            fatalError("inbox.json is not in the test bundle")
        }
        return text
    }

    static func object(_ text: String) -> [String: Any] {
        guard
            let data = text.data(using: .utf8),
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return [:] }
        return object
    }
}

private func equal(_ lhs: Any?, _ rhs: Any?) -> Bool {
    let normalise: (Any?) -> NSObject = { value in
        guard let value, !(value is NSNull) else { return NSNull() }
        return value as? NSObject ?? NSNull()
    }
    return normalise(lhs).isEqual(normalise(rhs))
}

@Suite("inbox.json — spec 006 IB011, IB013")
struct InboxConformanceTests {
    @Test func every_apply_sequence_ends_on_desktops_row() {
        let text = InboxVectors.raw()
        let file = InboxVectors.object(text)
        let out = InboxVectors.object(inboxConformance(vectorJson: text))
        let expected = file["apply"] as? [[String: Any]] ?? []
        let actual = out["apply"] as? [[String: Any]] ?? []
        #expect(expected.count == actual.count)
        #expect(expected.count >= 7)
        var failures: [String] = []
        for (want, got) in zip(expected, actual) where !equal(want["expected"], got["actual"]) {
            failures.append("\(want["name"] ?? ""): \(got)")
        }
        #expect(failures.isEmpty, "\(failures)")
    }

    @Test func the_views_answer_desktops_numbers() {
        let text = InboxVectors.raw()
        let file = InboxVectors.object(text)
        let out = InboxVectors.object(inboxConformance(vectorJson: text))
        let expected = (file["views"] as? [String: Any])?["expected"]
        #expect(equal(expected, out["views"]), "\(String(describing: out["views"]))")
    }
}
