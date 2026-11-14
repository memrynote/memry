import Foundation
import MemryCore
import Testing

@testable import Memry

@Suite("Semantic search settings display")
struct SemanticSearchDisplayTests {
    private let total: UInt64 = 206_690_052

    private func status(_ model: ModelState, embedded: UInt32 = 0, notes: UInt32 = 0) -> SemanticStatus {
        SemanticStatus(model: model, downloadBytes: total, embeddedNotes: embedded, totalNotes: notes)
    }

    @Test func off_shows_the_toggle_off_with_no_state_row() {
        let display = SemanticSearchDisplay(status(.off))
        #expect(!display.isOn)
        #expect(display.row == nil)
        #expect(SemanticSearchCopy.footer(size: display.size).contains(ByteCountFormatter.memry(Int64(total))))
    }

    @Test func downloading_shows_its_fraction_and_bytes() throws {
        let received = total * 2 / 5
        let display = SemanticSearchDisplay(status(.downloading(received: received, total: total)))
        #expect(display.isOn)
        guard case let .progress(title, detail, fraction) = display.row else {
            Issue.record("expected a progress row, got \(String(describing: display.row))")
            return
        }
        #expect(title == SemanticSearchCopy.downloading)
        #expect(abs(fraction - 0.4) < 0.001)
        #expect(detail.contains(ByteCountFormatter.memry(Int64(received))))
    }

    @Test func waiting_for_wifi_says_it_is_paused() {
        let display = SemanticSearchDisplay(status(.waitingForWifi(received: 10, total: total)))
        guard case let .progress(title, detail, _) = display.row else {
            Issue.record("expected a progress row")
            return
        }
        #expect(display.isOn)
        #expect(title == SemanticSearchCopy.waitingForWifi)
        #expect(detail.contains("Wi-Fi"))
    }

    @Test(arguments: [
        (DownloadFailure.mismatch, SemanticSearchCopy.damagedTitle),
        (DownloadFailure.http(status: 503), SemanticSearchCopy.serverTitle),
        (DownloadFailure.network, SemanticSearchCopy.networkTitle),
        (DownloadFailure.storage, SemanticSearchCopy.storageTitle)
    ])
    func each_failure_gets_its_own_sentence(failure: DownloadFailure, title: String) {
        let display = SemanticSearchDisplay(status(.failed(received: 1, total: total, failure: failure)))
        #expect(display.isOn)
        guard case let .failed(shown, guidance) = display.row else {
            Issue.record("expected a failed row")
            return
        }
        #expect(shown == title)
        #expect(!guidance.isEmpty)
    }

    @Test func ready_shows_n_of_m_notes() {
        let display = SemanticSearchDisplay(status(.ready, embedded: 12, notes: 340))
        #expect(display.isOn)
        #expect(display.row == .ready(indexed: "12 of 340"))
    }

    @Test func every_semantic_error_maps_to_a_known_sentence() {
        let errors: [SemanticError] = [.Unavailable, .Inference(what: "x"), .Poisoned]
        for error in errors {
            #expect(ErrorMapping.userFacing(error as any Error).code.description.hasPrefix("semantic."))
        }
        let space = SemanticError.Storage(source: .OutOfSpace(neededBytes: 2, availableBytes: 1))
        #expect(ErrorMapping.userFacing(space as any Error).code.description == "storage.outOfSpace")
    }

    @Test func a_pending_flip_wins_over_the_last_status() {
        #expect(SemanticSearchDisplay(status(.off), pending: .enabling).isOn)
        let turningOff = SemanticSearchDisplay(status(.ready, embedded: 1, notes: 2), pending: .disabling)
        #expect(!turningOff.isOn)
        #expect(turningOff.row == nil)
    }
}
