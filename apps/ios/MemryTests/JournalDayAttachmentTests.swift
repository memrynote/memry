import MemryCore
import Observation
import SwiftUI
import Synchronization
import Testing
import UIKit
@testable import Memry

// #5644, REVIEW-5685. The Day screen builds the shown day and its neighbours.
// Only the shown day downloads its attachments, which it does on any usable
// path whatever the Download attachments setting, and it asks again for a
// picture a pulled body brings while it is open. Each test hosts a real day
// page in a scene window over a real journal core; the note reader and the
// filler are scripted.

private func picture(_ url: String) -> Block {
    Block(id: "image-\(url)", kind: "image", depth: 0, props: [BlockProp(name: "url", value: url)], inline: [])
}

private let paragraph = Block(id: "p1", kind: "paragraph", depth: 0, props: [], inline: [])

private func binding(_ id: String, localPath: String? = nil) -> BlockAttachment {
    .bound(attachment: CachedAttachment(
        attachmentId: id, manifest: "{}", noteRefs: ["day"], remoteSize: 100,
        localPath: localPath, downloadedAt: localPath == nil ? nil : 1,
        unmeteredOnly: true, pinned: false, filename: "shot.png", mimeType: "image/png"
    ))
}

/// The day's blocks and their bindings, which a test changes as a pulled
/// body would.
private final class DayReader: NotesReading, @unchecked Sendable {
    private let state: Mutex<(blocks: [Block], bindings: [String: BlockAttachment])>
    private let written = Mutex<[URL]>([])

    init(blocks: [Block], bindings: [String: BlockAttachment]) {
        state = Mutex((blocks, bindings))
    }

    func land(_ blocks: [Block], bindings: [String: BlockAttachment]) {
        state.withLock { $0 = (blocks, bindings) }
    }

    /// The bytes of `id` arrived: its rows now carry a file, on disk, as
    /// `intactPath` reads a missing one as not downloaded.
    func landBytes(of id: String) {
        let path = "journal-\(UUID().uuidString)-\(id)"
        let file = AttachmentPaths.url(for: path)
        FileManager.default.createFile(atPath: file.path(percentEncoded: false), contents: Data())
        written.withLock { $0.append(file) }
        state.withLock { state in
            for (url, bound) in state.bindings {
                if case let .bound(attachment) = bound, attachment.attachmentId == id {
                    state.bindings[url] = binding(id, localPath: path)
                }
            }
        }
    }

    /// Deletes every file `landBytes` wrote: they sit in the shared images
    /// directory, not under the test's vault.
    func removeLandedBytes() {
        written.withLock { $0 }.forEach { try? FileManager.default.removeItem(at: $0) }
    }

    func folders() async throws -> [FolderSummary] { [] }
    func list() async throws -> [NoteSummary] { [] }
    func read(id: String) async throws -> NoteDetail? { nil }
    func blocks(id: String) async throws -> [Block]? { state.withLock { $0.blocks } }
    func attachmentForBlock(id: String, url: String) async throws -> BlockAttachment {
        state.withLock { $0.bindings[url] } ?? .unknown
    }
}

/// Records each attachment fetch and lands it. A body pull lands nothing
/// unless the test armed it.
private final class DayFiller: VaultFilling, @unchecked Sendable {
    private let calls = Mutex<[String]>([])
    private let pulls = Mutex(0)
    private let nextPull = Mutex<(@Sendable () -> Void)?>(nil)
    private let reader: DayReader

    init(reader: DayReader) { self.reader = reader }

    var fetched: [String] { calls.withLock { $0 } }
    var pulled: Int { pulls.withLock { $0 } }

    /// The next body pull lands `change`, as a desktop body edit arrives:
    /// CRDT updates with no record, which no sync pass pulls.
    func landOnNextPull(_ change: @escaping @Sendable () -> Void) {
        nextPull.withLock { $0 = change }
    }

    func isFirstSyncComplete() async throws -> Bool { true }
    func firstSync(
        progress: @escaping @MainActor @Sendable (SyncProgress) -> Void
    ) async throws -> FirstSyncSummary { .none }

    func pullNoteBody(noteId: String) async throws -> BodyFetchSummary {
        pulls.withLock { $0 += 1 }
        let change = nextPull.withLock { pending in
            defer { pending = nil }
            return pending
        }
        guard let change else { return BodyFetchSummary(updates: 0, baselines: 0, stopped: false) }
        change()
        return BodyFetchSummary(updates: 1, baselines: 0, stopped: false)
    }

    func fetchAttachment(attachmentId: String, reachable: Reachable) async throws -> AttachmentFetchSummary {
        calls.withLock { $0.append(attachmentId) }
        reader.landBytes(of: attachmentId)
        return AttachmentFetchSummary(downloaded: true, deferred: false, bytes: 100, localPath: attachmentId)
    }
}

@MainActor
@Observable
private final class Shown {
    var value: Bool
    init(_ value: Bool) { self.value = value }
}

/// The pager's part: whether this page is the shown one.
private struct DayHost: View {
    let store: JournalStore
    let page: JournalDayPageModel
    let shown: Shown

    var body: some View {
        JournalDayPage(
            store: store, date: JournalTestVault.today, model: page, isShown: shown.value, open: { _ in },
            titleCollapsed: .constant(false), fog: .constant(nil)
        )
    }
}

extension KeyWindowSuites {
    @MainActor
    @Suite("Journal day attachments", .serialized)
    struct JournalDayAttachmentTests {
        private struct Fixture {
            let vault: JournalTestVault
            let page: JournalDayPageModel
            let reader: DayReader
            let filler: DayFiller
            let shown: Shown
            let window: UIWindow
        }

        /// Today, with an entry whose body `reader` scripts, on a page in a scene
        /// window.
        private func open(_ reader: DayReader, shown: Bool) async throws -> Fixture {
            let vault = try JournalTestVault()
            try vault.write("entry", on: JournalTestVault.today)
            let filler = DayFiller(reader: reader)
            let context = JournalVaultContext(
                reader: reader, filler: filler, writer: nil, editor: nil, metadataWriter: nil, search: nil, noteTasks: nil
            )
            vault.store.context = context
            await vault.store.loadDay(JournalTestVault.today)
            let page = JournalDayPageModel(store: vault.store, date: JournalTestVault.today, context: context)
            let shown = Shown(shown)
            let scene = try #require(UIApplication.shared.connectedScenes.first as? UIWindowScene)
            let window = UIWindow(windowScene: scene)
            window.rootViewController = UIHostingController(rootView: DayHost(store: vault.store, page: page, shown: shown))
            window.makeKeyAndVisible()
            return Fixture(vault: vault, page: page, reader: reader, filler: filler, shown: shown, window: window)
        }

        private func until(_ condition: () -> Bool) async {
            for _ in 0..<300 where !condition() {
                try? await Task.sleep(for: .milliseconds(20))
            }
        }

        /// Opening today builds yesterday and tomorrow too. Building a neighbour
        /// is a prefetch: under Never or On Wi-Fi it must not download over
        /// cellular. It asks once the user pages to it.
        @Test(.timeLimit(.minutes(1))) func a_neighbour_asks_for_nothing_until_it_is_shown() async throws {
            let reader = DayReader(blocks: [picture("shot.png")], bindings: ["shot.png": binding("att-1")])
            defer { reader.removeLandedBytes() }
            let day = try await open(reader, shown: false)
            defer { day.window.isHidden = true }

            await until { day.page.read.attachments["shot.png"] != nil }
            // The read is done; give a fetch following it time to start.
            for _ in 0..<25 where day.filler.fetched.isEmpty {
                try await Task.sleep(for: .milliseconds(20))
            }
            #expect(day.filler.fetched.isEmpty, "a neighbour built as a prefetch downloaded its attachments")

            day.shown.value = true
            await until { !day.filler.fetched.isEmpty }
            #expect(day.filler.fetched == ["att-1"], "the day the user paged to did not download its picture")
        }

        /// A desktop edit adds a picture while the day is open. Under Never the
        /// redriver downloads nothing, so the page is the only thing that asks:
        /// the pass pulls the body, the re-read binds the picture, and the page
        /// downloads it without being reopened.
        @Test(.timeLimit(.minutes(1))) func the_shown_day_downloads_a_picture_a_pulled_body_brings() async throws {
            let reader = DayReader(blocks: [paragraph], bindings: [:])
            defer { reader.removeLandedBytes() }
            let day = try await open(reader, shown: true)
            defer { day.window.isHidden = true }

            // The open read and pulled the body, which brought nothing. Its work
            // ends before the pass, so nothing from the open sees the picture.
            await until { day.filler.pulled >= 1 && day.page.read.blocksRead }
            for _ in 0..<20 { try await Task.sleep(for: .milliseconds(20)) }
            #expect(day.filler.fetched.isEmpty)
            day.filler.landOnNextPull {
                reader.land([paragraph, picture("shot.png")], bindings: ["shot.png": binding("att-1")])
            }
            await day.vault.store.syncFinished()

            await until { !day.filler.fetched.isEmpty }
            #expect(day.filler.fetched == ["att-1"], "the picture the pulled body brought was never downloaded")
        }
    }
}
