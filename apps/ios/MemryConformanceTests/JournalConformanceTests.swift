import Foundation
import MemryCore
import Testing

// Spec 005-journal JP080: `journal.json` through the FFI. The expectations are
// the committed values desktop's TypeScript produced
// (`@memry/domain-notes/journal`, `journal-api.ts`); the actual values come
// out of `MemryCore`. Nothing here computes an expectation.
//
// Reached two ways, both production code paths:
// - the free functions the shell calls (`journalPreview`, `journalWordCount`,
//   `journalWeekday`) for the cases they cover;
// - the journal conformance seam (`journalConformance`) for every section,
//   running the same `domain::journal_rules` functions `Journal.month`,
//   `year`, `streak` and template seeding run.

private final class JournalVectorsMarker {}

private enum JournalVectors {
    static func raw() -> String {
        guard
            let url = Bundle(for: JournalVectorsMarker.self)
                .url(forResource: "journal", withExtension: "json", subdirectory: "test-vectors"),
            let text = try? String(contentsOf: url, encoding: .utf8)
        else {
            fatalError("journal.json is not in the test bundle")
        }
        return text
    }

    static func object() -> [String: Any] {
        (try? JSONSerialization.jsonObject(with: Data(raw().utf8)) as? [String: Any]) ?? [:]
    }
}

private func cases(_ object: Any?) -> [[String: Any]] {
    object as? [[String: Any]] ?? []
}

/// JSON equality through `NSObject` comparison (2 and 2.0 compare equal).
private func same(_ lhs: Any?, _ rhs: Any?) -> Bool {
    let normalise: (Any?) -> NSObject = { value in
        guard let value, !(value is NSNull) else { return NSNull() }
        return value as? NSObject ?? NSNull()
    }
    return normalise(lhs).isEqual(normalise(rhs))
}

@Suite("journal.json — spec 005-journal JP080")
struct JournalConformanceTests {
    @Test func preview_words_and_weekday_through_the_free_functions() {
        let file = JournalVectors.object()
        let previews = cases(file["preview"]).filter { ($0["maxLength"] as? Int) == 100 }
        #expect(!previews.isEmpty)
        for case_ in previews {
            let content = case_["content"] as? String ?? ""
            #expect(journalPreview(text: content) == case_["expected"] as? String, "\(case_["name"] ?? "")")
        }
        for case_ in cases(file["words"]) {
            let text = case_["text"] as? String ?? ""
            #expect(journalWordCount(text: text) == UInt64(case_["words"] as? Int ?? -1), "\(text)")
        }
        for case_ in cases(file["weekday"]) {
            let date = case_["date"] as? String ?? ""
            #expect(journalWeekday(date: date).map(Int.init) == case_["weekday"] as? Int, "\(date)")
        }
    }

    @Test func every_section_through_the_seam() throws {
        let file = JournalVectors.object()
        let computedText = journalConformance(fileJson: JournalVectors.raw())
        let computed = try JSONSerialization.jsonObject(with: Data(computedText.utf8)) as? [String: Any] ?? [:]
        let sections = [
            "preview", "words", "activity", "streak", "monthDays", "monthActivity",
            "yearStats", "weekday", "orderedWeekdays", "templateResolution", "templateApply"
        ]
        for section in sections {
            let expectedCases = cases(file[section])
            let actual = computed[section] as? [Any] ?? []
            #expect(!expectedCases.isEmpty, "\(section) is empty")
            #expect(actual.count == expectedCases.count, "\(section) count")
            for (index, case_) in expectedCases.enumerated() where index < actual.count {
                let expected: Any? = switch section {
                case "words":
                    ["words": case_["words"], "characters": case_["characters"], "level": case_["level"]]
                case "activity": case_["level"]
                case "weekday": case_["weekday"]
                default: case_["expected"]
                }
                #expect(same(actual[index], expected), "\(section)[\(index)]")
            }
        }
    }
}
