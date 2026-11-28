import Foundation
import Testing
@testable import Memry

// What a MetricKit crash or hang sends: enough to tell a watchdog kill from a
// background-task kill and to find the frame again, and nothing MetricKit
// wrote as text (bundle ids, pids, paths, exception messages).

/// `MXCallStackTree.jsonRepresentation()`, innermost frame at the root.
private func callStack(attributed: [(String, Int)], other: [(String, Int)] = [("libsystem_kernel.dylib", 4096)]) -> Data {
    func chain(_ frames: [(String, Int)]) -> [[String: Any]] {
        guard let (binary, offset) = frames.first else { return [] }
        return [[
            "binaryUUID": "70B89F27-1634-3580-A695-57CDB41D7743",
            "binaryName": binary,
            "offsetIntoBinaryTextSegment": offset,
            "address": 7_203_916_472,
            "sampleCount": 1,
            "subFrames": chain(Array(frames.dropFirst()))
        ]]
    }
    let tree: [String: Any] = [
        "callStackPerThread": true,
        "callStacks": [
            ["threadAttributed": false, "callStackRootFrames": chain(other)],
            ["threadAttributed": true, "callStackRootFrames": chain(attributed)]
        ]
    ]
    return (try? JSONSerialization.data(withJSONObject: tree)) ?? Data()
}

/// `SafeDimensionValueSchema` in `packages/contracts/src/telemetry-api.ts`.
private func isSafeDimension(_ value: String) -> Bool {
    (1...64).contains(value.count) && !value.contains("@") && !value.contains("://")
        && !value.contains("/") && !value.contains("\\")
        && value.range(of: #"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"#, options: [.regularExpression, .caseInsensitive]) == nil
}

struct CrashReporterTests {
    private let hungMainThread = callStack(attributed: [
        ("libsystem_kernel.dylib", 0x1a2c),
        ("SwiftUI", 0x44_0000),
        ("Memry", 0x2b_3c4d),
        ("Memry", 0x10),
        ("UIKitCore", 0x99)
    ])

    @Test func aWatchdogKillOfAHungSceneGroupsByItsTerminationCode() throws {
        let crash = CrashReporter.Crash(
            exception: 10, code: 0, signal: 9,
            terminationReason: "Namespace FRONTBOARD, Code 0x8badf00d scene-update watchdog transgression: "
                + "app<com.memrynote.app(1234)>:567 exhausted real (wall clock) time allowance of 10.00 seconds",
            build: "1017", callStack: hungMainThread
        )
        let event = CrashReporter.crashEvent(crash, app: "Memry")

        #expect(event.name == .appCrashed)
        #expect(event.errorCode == "EXC_CRASH:SIGKILL:FRONTBOARD:0x8badf00d")
        let error = try #require(event.error)
        #expect(error.message == "EXC_CRASH:SIGKILL termination=FRONTBOARD:0x8badf00d reason=watchdog kind=scene_update code=0x0 build=1017 top=Memry+0x2b3c4d")
        #expect(error.stack == """
            at libsystem_kernel.dylib+0x1a2c (libsystem_kernel.dylib)
            at SwiftUI+0x440000 (SwiftUI)
            at Memry+0x2b3c4d (Memry)
            at Memry+0x10 (Memry)
            at UIKitCore+0x99 (UIKitCore)
        """)
    }

    @Test func aBackgroundTaskKillGroupsApartFromAWatchdogKill() {
        let crash = CrashReporter.Crash(
            exception: 10, signal: 9,
            terminationReason: "Namespace RUNNINGBOARD, Code 2343432205 Background Task 7 (\"sync-exchange\") was held too long",
            build: "1017", callStack: nil
        )
        let event = CrashReporter.crashEvent(crash, app: "Memry")

        #expect(event.errorCode == "EXC_CRASH:SIGKILL:RUNNINGBOARD:0x8badf00d")
        #expect(event.error?.message == "EXC_CRASH:SIGKILL termination=RUNNINGBOARD:0x8badf00d reason=watchdog kind=background_task build=1017")
        #expect(event.error?.stack == nil)
    }

    @Test func nothingMetricKitWroteAsTextLeavesTheDevice() throws {
        let crash = CrashReporter.Crash(
            exception: 6, signal: 5,
            terminationReason: "Namespace SPRINGBOARD, Code 0xdead10cc /var/mobile/Containers/Data/a.db k@example.com 1B4E28BA-2FA1-11D2-883F-0016D3CCA427",
            objcException: "NSInvalidArgumentException: note “Divorce plan” not found",
            build: "1017 (beta)/x",
            callStack: callStack(attributed: [("/private/var/containers/Bundle/Memry.app/Memry", 1)])
        )
        let event = CrashReporter.crashEvent(crash, app: "Memry")
        let error = try #require(event.error)
        let errorCode = try #require(event.errorCode)

        #expect(isSafeDimension(errorCode))
        for text in [error.message, error.stack ?? ""] {
            #expect(!text.contains("/"))
            #expect(!text.contains("@"))
            #expect(!text.contains("Divorce"))
            #expect(text.range(of: "[0-9A-F]{8}-[0-9A-F]{4}", options: .regularExpression) == nil)
        }
        #expect(error.message == "EXC_BREAKPOINT:SIGTRAP termination=SPRINGBOARD:0xdead10cc reason=file_lock_suspended objc=NSInvalidArgumentException build=1017")
        #expect(error.stack == "    at unknown+0x1 (unknown)")
    }

    @Test func anUnreadableTerminationReasonKeepsTheExceptionCode() {
        let crash = CrashReporter.Crash(exception: 1, code: 1, signal: 11, terminationReason: "something new")
        let event = CrashReporter.crashEvent(crash, app: "Memry")
        #expect(event.errorCode == "EXC_BAD_ACCESS:SIGSEGV")
        #expect(event.error?.message == "EXC_BAD_ACCESS:SIGSEGV termination=unparsed code=0x1")
    }

    @Test func aHangCarriesItsDurationBuildAndMainThreadFrames() throws {
        let event = CrashReporter.hangEvent(durationMs: 4200, build: "1017", callStack: hungMainThread, app: "Memry")

        #expect(event.name == .appErrorSeen)
        #expect(event.action == "hang")
        #expect(event.errorCode == "APP_HANG")
        #expect(event.metrics?.durationMs == 4200)
        #expect(event.error?.message == "APP_HANG build=1017 top=Memry+0x2b3c4d")
        let stack = try #require(event.error?.stack)
        #expect(stack.split(separator: "\n").count == 5)
    }

    @Test func aDeepStackKeepsItsInnermostFrames() {
        let deep = callStack(attributed: (0..<100).map { ("Memry", $0) })
        let frames = CrashReporter.frames(deep)
        #expect(frames.count == CrashReporter.frameLimit)
        #expect(frames.first == CrashReporter.Frame(binary: "Memry", offset: 0))
    }

    @Test func theDetailEncodesAsTheContractNamesIt() throws {
        let event = CrashReporter.hangEvent(durationMs: 1, build: "1017", callStack: hungMainThread, app: "Memry")
        let json = try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(event)) as? [String: Any])
        let error = try #require(json["error"] as? [String: Any])
        #expect(Set(error.keys) == ["message", "stack"])
        #expect((error["stack"] as? String)?.count ?? 0 <= 4000)
        #expect((error["message"] as? String)?.count ?? 0 <= 512)
    }
}
