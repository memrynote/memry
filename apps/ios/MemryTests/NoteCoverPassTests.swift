//
//  NoteCoverPassTests.swift
//  #5644, REVIEW-5685R2 #1 and #2: a cover whose bytes have not arrived asks
//  again when a sync pass runs (`NoteCoverBand`'s `.onChange(of:
//  syncPasses)`), and only when waiting can bring them, as desktop asks on
//  sync (`asksOnSync` in `note-files-download-notice.tsx`).
//

import Foundation
import MemryCore
import Observation
import SwiftUI
import Testing
import UIKit

@testable import Memry

extension KeyWindowSuites {
    @MainActor
    @Suite("A cover on a sync pass", .serialized)
    struct NoteCoverPassTests {
        @Observable final class Passes { var count = 0 }

        private struct Host: View {
            let fillers: [ScriptedAttachmentFiller]
            let passes: Passes
            let reader = ScriptedAttachments(
                blocks: [],
                bindings: ["cover.jpg": .bound(attachment: cached(id: "att-cover", localPath: nil))]
            )
            let cover = NoteCoverValue.of(#"{"ref":"attachments/n1/cover.jpg"}"#)!
            var body: some View {
                VStack {
                    ForEach(fillers.indices, id: \.self) { index in
                        NoteCoverBand(
                            cover: cover, noteId: "n1", reader: reader, filler: fillers[index],
                            reachability: FixedPath(path: .wifi), height: 40
                        )
                    }
                }
                .environment(\.vaultSyncPasses, passes.count)
            }
        }


        @Test(.timeLimit(.minutes(1)))
        func aWaitingCoverIsAskedAgainOnAPass() async throws {
            let filler = ScriptedAttachmentFiller(summary: pending)
            let passes = Passes()
            let window = show(Host(fillers: [filler], passes: passes))
            defer { window.isHidden = true }
            try await settle { filler.fetched.count == 1 }

            passes.count += 1
            try await settle { filler.fetched.count == 2 }

            #expect(filler.fetched == ["att-cover", "att-cover"], "the pass did not ask for the waiting cover")
        }

        /// A deferred cover is the control: once it is asked again, so is every
        /// band the pass asks.
        @Test(.timeLimit(.minutes(1)))
        func aPassAsksAgainOnlyAfterAFailureWaitingFixes() async throws {
            let deferred = ScriptedAttachmentFiller(summary: pending)
            let offline = ScriptedAttachmentFiller(summary: pending, failure: .Api(source: .Transport(source: .Offline)))
            let corrupt = ScriptedAttachmentFiller(summary: pending, failure: .AttachmentCorrupt(what: "chunk"))
            let unverified = ScriptedAttachmentFiller(
                summary: pending, failure: .AttachmentUnverified(deviceId: "device")
            )
            #expect(ErrorMapping.userFacing(SyncError.Api(source: .Transport(source: .Offline))).recourse == .retryLater)
            #expect(ErrorMapping.userFacing(SyncError.AttachmentCorrupt(what: "chunk")).recourse == .retry)
            #expect(ErrorMapping.userFacing(SyncError.AttachmentUnverified(deviceId: "device")).recourse == .blocked)
            let all = [deferred, offline, corrupt, unverified]
            let passes = Passes()
            let window = show(Host(fillers: all, passes: passes))
            defer { window.isHidden = true }
            try await settle { all.allSatisfy { $0.fetched.count == 1 } }

            passes.count += 1
            try await settle { deferred.fetched.count == 2 && offline.fetched.count == 2 }
            try await Task.sleep(for: .milliseconds(300))

            #expect(offline.fetched.count == 2, "a failure waiting fixes was not asked again")
            #expect(corrupt.fetched.count == 1, "a corrupt cover downloaded again on a pass")
            #expect(unverified.fetched.count == 1, "an unverifiable cover went back to the server on a pass")
        }

        private func show(_ host: Host) -> UIWindow {
            let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 400, height: 800))
            window.rootViewController = UIHostingController(rootView: host)
            window.makeKeyAndVisible()
            return window
        }

        private func settle(_ done: () -> Bool) async throws {
            for _ in 0 ..< 100 where !done() {
                try await Task.sleep(for: .milliseconds(50))
            }
        }
    }
}

private let pending = AttachmentFetchSummary(downloaded: false, deferred: true, bytes: 0, localPath: nil)
