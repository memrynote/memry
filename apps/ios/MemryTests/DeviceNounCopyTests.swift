import Foundation
import Testing

// Copy names the device through `ThisDevice.noun`, so an iPad never reads
// "this iPhone" (#4338). Reads the sources through `#filePath`, so it runs on
// a simulator, where the checkout is on the host disk.

@Suite("Device noun in copy")
struct DeviceNounCopyTests {
    private static var roots: [URL] {
        let app = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Memry", isDirectory: true)
        return [app.appendingPathComponent("Features", isDirectory: true), app.appendingPathComponent("Core", isDirectory: true)]
    }

    @Test("no source line outside comments and logs says this iPhone or this phone")
    func copyUsesTheDeviceNoun() throws {
        try #require(Self.roots.allSatisfy { FileManager.default.fileExists(atPath: $0.path) })
        // A user-facing phrase that hard-codes the phone. Comments and log
        // lines are skipped: they are not shown to the user.
        let hardCoded = try Regex(#"\b[Tt]his (iPhone|phone)\b|\b[Yy]our phone\b|\bthe phone\b|\bon iPhone\b"#)
        let trailingComment = try Regex(#"\s//\s.*$"#)
        var hits: [String] = []
        for root in Self.roots {
            let files = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil)?
                .compactMap { $0 as? URL }
                .filter { $0.pathExtension == "swift" } ?? []
            for file in files {
                let lines = try String(contentsOf: file, encoding: .utf8).components(separatedBy: "\n")
                for (index, line) in lines.enumerated() {
                    let code = line.replacing(trailingComment, with: "")
                    let trimmed = code.trimmingCharacters(in: .whitespaces)
                    if trimmed.hasPrefix("//") || trimmed.contains("Log.") { continue }
                    if code.contains(hardCoded) { hits.append("\(file.lastPathComponent):\(index + 1)") }
                }
            }
        }
        #expect(hits.isEmpty, "hard-coded device noun: \(hits)")
    }
}
