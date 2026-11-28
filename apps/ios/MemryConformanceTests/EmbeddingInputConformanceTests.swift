import Foundation
import MemryCore
import Testing

// `embedding-input.json` through the FFI (docs/protocol/15). The expectations
// are what desktop's `embedding-input.ts` produced (imported for real by the
// vector script); the actual text comes out of `MemryCore`'s
// `embeddingInputConformance`, the shaping the embedder will use here.

private final class EmbeddingInputVectorsMarker {}

private func embeddingInputVectors() -> (file: [String: Any], out: [String: Any]) {
    guard
        let url = Bundle(for: EmbeddingInputVectorsMarker.self)
            .url(forResource: "embedding-input", withExtension: "json", subdirectory: "test-vectors"),
        let text = try? String(contentsOf: url, encoding: .utf8)
    else {
        fatalError("embedding-input.json is not in the test bundle")
    }
    let parse = { (text: String) -> [String: Any] in
        (try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any]) ?? [:]
    }
    return (parse(text), parse(embeddingInputConformance(vectorJson: text)))
}

private func same(_ lhs: Any?, _ rhs: Any?) -> Bool {
    let normalise: (Any?) -> NSObject = { value in
        guard let value, !(value is NSNull) else { return NSNull() }
        return value as? NSObject ?? NSNull()
    }
    return normalise(lhs).isEqual(normalise(rhs))
}

private func mismatches(_ key: String) -> (count: Int, failures: [String]) {
    let (file, out) = embeddingInputVectors()
    let expected = file[key] as? [[String: Any]] ?? []
    let actual = out[key] as? [[String: Any]] ?? []
    var failures = expected.count == actual.count ? [] : ["\(expected.count) cases, \(actual.count) results"]
    for (want, got) in zip(expected, actual) where !same(want["expected"], got["actual"]) {
        failures.append("\(want["name"] ?? ""): \(want["pins"] ?? "")")
    }
    return (expected.count, failures)
}

@Suite("embedding-input.json — docs/protocol/15")
struct EmbeddingInputConformanceTests {
    @Test func every_note_shapes_as_desktop_does() {
        let (count, failures) = mismatches("cases")
        #expect(count >= 20)
        #expect(failures.isEmpty, "\(failures)")
    }

    @Test func every_query_shapes_as_desktop_does() {
        let (count, failures) = mismatches("queries")
        #expect(count >= 5)
        #expect(failures.isEmpty, "\(failures)")
    }
}
