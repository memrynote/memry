import Foundation
import Testing

@testable import Memry

// Spec 007 CL070/CL074: `calendar-write.json`'s writer-compat half. Which
// linked desktops the CalDAV connect notice lists follows desktop's
// `isAppVersionBelow` exactly; the object and recurrence halves are checked by
// the core's `calendar_write_vectors` tests.

private final class WriteVectorsMarker {}

@Suite("calendar-write.json — spec 007 CL070")
struct CalendarWriteConformanceTests {
    @Test func the_writer_compat_floor_reads_versions_as_desktop_does() throws {
        let url = try #require(
            Bundle(for: WriteVectorsMarker.self).url(forResource: "calendar-write", withExtension: "json", subdirectory: "test-vectors")
        )
        let file = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        let compat = try #require(file["writerCompat"] as? [String: Any])
        let minimum = try #require(compat["minimum"] as? String)
        #expect(minimum == CalendarWriterCompat.minimumVersion)
        let versions = compat["versions"] as? [[String: Any]] ?? []
        #expect(versions.count >= 10)
        for row in versions {
            let version = row["version"] as? String ?? ""
            #expect(CalendarWriterCompat.isBelow(version, minimum) == (row["below"] as? Bool), "\(version)")
        }
    }
}
