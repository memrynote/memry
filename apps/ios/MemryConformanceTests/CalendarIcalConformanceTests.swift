import Foundation
import MemryCore
import Testing

// Spec 007 CL070/CL073: `calendar-ical.json` through the FFI. The
// expectations are what desktop's own `parseIcsFeed` answered (imported for
// real by the vector script); the actual values come out of `MemryCore`'s
// `calendarIcalConformance`, the same parser subscribed feeds use here.

private final class IcalVectorsMarker {}

private func icalVectors() -> (file: [String: Any], out: [String: Any]) {
    guard
        let url = Bundle(for: IcalVectorsMarker.self)
            .url(forResource: "calendar-ical", withExtension: "json", subdirectory: "test-vectors"),
        let text = try? String(contentsOf: url, encoding: .utf8)
    else {
        fatalError("calendar-ical.json is not in the test bundle")
    }
    let parse = { (text: String) -> [String: Any] in
        (try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any]) ?? [:]
    }
    return (parse(text), parse(calendarIcalConformance(vectorJson: text)))
}

private func same(_ lhs: Any?, _ rhs: Any?) -> Bool {
    let normalise: (Any?) -> NSObject = { value in
        guard let value, !(value is NSNull) else { return NSNull() }
        return value as? NSObject ?? NSNull()
    }
    return normalise(lhs).isEqual(normalise(rhs))
}

@Suite("calendar-ical.json — spec 007 CL070, CL073")
struct CalendarIcalConformanceTests {
    @Test func every_feed_expands_as_desktop_does() {
        let (file, out) = icalVectors()
        let expected = file["cases"] as? [[String: Any]] ?? []
        let actual = out["cases"] as? [[String: Any]] ?? []
        #expect(expected.count == actual.count && expected.count >= 3)
        var failures: [String] = []
        for (want, got) in zip(expected, actual) where !same(want["expected"], got["actual"]) {
            failures.append("\(want["name"] ?? ""): \(got["error"] ?? got["actual"] ?? "")")
        }
        #expect(failures.isEmpty, "\(failures)")
    }

    @Test func links_normalise_and_hash_as_desktop_does() {
        let (file, out) = icalVectors()
        #expect(same(file["urls"], out["urls"]))
    }
}
