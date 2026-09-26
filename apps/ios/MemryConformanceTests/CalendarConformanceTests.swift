import Foundation
import MemryCore
import Testing

// Spec 007 CL011-CL015: `calendar.json` through the FFI. The expectations are
// the committed values restated from desktop's calendar handlers, projection
// and writes; the actual values come out of `MemryCore`'s conformance seam
// (`calendarConformance`), which runs the vector through the same apply path a
// pull uses, the same range projection `Calendar.range` answers and the same
// writes `Calendar` makes. Nothing here computes an expectation.

private final class CalendarVectorsMarker {}

private enum CalendarVectors {
    static func raw() -> String {
        guard
            let url = Bundle(for: CalendarVectorsMarker.self)
                .url(forResource: "calendar", withExtension: "json", subdirectory: "test-vectors"),
            let text = try? String(contentsOf: url, encoding: .utf8)
        else {
            fatalError("calendar.json is not in the test bundle")
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

    static func run() -> (file: [String: Any], out: [String: Any]) {
        let text = raw()
        return (object(text), object(calendarConformance(vectorJson: text)))
    }
}

private func equal(_ lhs: Any?, _ rhs: Any?) -> Bool {
    let normalise: (Any?) -> NSObject = { value in
        guard let value, !(value is NSNull) else { return NSNull() }
        return value as? NSObject ?? NSNull()
    }
    return normalise(lhs).isEqual(normalise(rhs))
}

@Suite("calendar.json — spec 007 CL011, CL012, CL013")
struct CalendarConformanceTests {
    @Test func every_apply_sequence_ends_on_desktops_row() {
        let (file, out) = CalendarVectors.run()
        #expect(out["error"] == nil, "\(out["error"] ?? "")")
        let expected = file["apply"] as? [[String: Any]] ?? []
        let actual = out["apply"] as? [[String: Any]] ?? []
        #expect(expected.count == actual.count)
        #expect(expected.count >= 17)
        var failures: [String] = []
        for (want, got) in zip(expected, actual) where !equal(want["expected"], got["actual"]) {
            failures.append("\(want["name"] ?? ""): \(got)")
        }
        #expect(failures.isEmpty, "\(failures)")
    }

    @Test func every_range_query_answers_desktops_projection() {
        let (file, out) = CalendarVectors.run()
        let queries = (file["projection"] as? [String: Any])?["queries"] as? [[String: Any]] ?? []
        let actual = (out["projection"] as? [String: Any])?["queries"] as? [Any] ?? []
        #expect(queries.count == actual.count)
        for (want, got) in zip(queries, actual) {
            #expect(equal(want["expected"], got), "\(want["name"] ?? "")")
        }
    }

    @Test func search_ranks_as_desktop_does() {
        let (file, out) = CalendarVectors.run()
        let searches = (file["projection"] as? [String: Any])?["searches"] as? [[String: Any]] ?? []
        let actual = (out["projection"] as? [String: Any])?["searches"] as? [Any] ?? []
        for (want, got) in zip(searches, actual) {
            #expect(equal(want["expected"], got), "\(want["query"] ?? "")")
        }
    }

    @Test func every_write_emits_desktops_record() {
        let (file, out) = CalendarVectors.run()
        let writes = file["writes"] as? [String: Any] ?? [:]
        let got = out["writes"] as? [String: Any] ?? [:]
        #expect(equal((writes["create"] as? [String: Any])?["expected"], got["create"]))
        let updates = writes["updates"] as? [[String: Any]] ?? []
        let actualUpdates = got["updates"] as? [Any] ?? []
        for (want, actual) in zip(updates, actualUpdates) {
            #expect(equal(want["expected"], actual), "\(want["name"] ?? "")")
        }
        let promote = (writes["promote"] as? [String: Any])?["expected"] as? [String: Any] ?? [:]
        let actualPromote = got["promote"] as? [String: Any] ?? [:]
        for key in ["event", "binding", "mirror"] {
            #expect(equal(promote[key], actualPromote[key]), "promote \(key)")
        }
        #expect(actualPromote["repeatReturnsSameEvent"] as? Bool == true)
        #expect(actualPromote["readOnlyRefused"] as? Bool == true)
        let selection = (writes["selection"] as? [String: Any])?["expected"] as? [String: Any] ?? [:]
        let actualSelection = got["selection"] as? [String: Any] ?? [:]
        #expect(equal(selection["source"], actualSelection["source"]))
        #expect(actualSelection["mirrorDeleted"] as? Bool == true)
        #expect(actualSelection["bindingDeleted"] as? Bool == true)
    }
}
