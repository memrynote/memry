import Darwin
import Foundation
import Testing
import UIKit

// DIAGNOSTIC ONLY (#5484): reverted before review. The Unit plan's host
// traps with "Block was expected to execute on queue [com.apple.main-thread]"
// and the xcresult keeps no backtrace, so the trapping thread prints its own.

private func say(_ text: String) {
    _ = text.withCString { write(2, $0, strlen($0)) }
}

private func onTrap(_ signal: Int32) {
    var frames = [UnsafeMutableRawPointer?](repeating: nil, count: 96)
    let count = backtrace(&frames, 96)
    say("TRAP5484 signal=\(signal) main=\(pthread_main_np())\n")
    backtrace_symbols_fd(&frames, count, 2)
    Darwin.signal(signal, SIG_DFL)
    raise(signal)
}

private func expired() -> @Sendable () -> Void {
    { say("PROBE5484 expiry handler called main=\(Thread.isMainThread)\n") }
}

@Suite("probe 5484")
@MainActor
struct Probe5484 {
    @Test func installTrapBacktrace() {
        signal(SIGTRAP, onTrap)
        signal(SIGABRT, onTrap)
    }

    @Test func aHeldTaskInTheTestHost() async throws {
        let application = UIApplication.shared
        let id = application.beginBackgroundTask(withName: "probe-5484", expirationHandler: expired())
        say("PROBE5484 began state=\(application.applicationState.rawValue) remaining=\(application.backgroundTimeRemaining)\n")
        try await Task.sleep(for: .seconds(70))
        say("PROBE5484 held 70 s\n")
        application.endBackgroundTask(id)
    }
}
