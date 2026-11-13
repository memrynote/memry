import Darwin
import Foundation
import os
import UIKit

/// Memory, battery and device readings for the #4437 bench.
enum Probe {
    /// `phys_footprint` is the number jetsam compares against the app's limit.
    static func footprint() -> (current: UInt64, lifetimePeak: UInt64) {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(
            MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
        let result = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
            }
        }
        guard result == KERN_SUCCESS else { return (0, 0) }
        return (info.phys_footprint, UInt64(max(0, info.ledger_phys_footprint_peak)))
    }

    /// Bytes left before jetsam; footprint + this = the app's current limit.
    static func available() -> UInt64 { UInt64(os_proc_available_memory()) }

    static func mb(_ bytes: UInt64) -> Double { (Double(bytes) / 1_048_576 * 10).rounded() / 10 }

    @MainActor static func battery() -> [String: Any] {
        UIDevice.current.isBatteryMonitoringEnabled = true
        let state: String
        switch UIDevice.current.batteryState {
        case .charging: state = "charging"
        case .full: state = "full"
        case .unplugged: state = "unplugged"
        default: state = "unknown"
        }
        return ["level": UIDevice.current.batteryLevel, "state": state]
    }

    static func thermal() -> String {
        switch ProcessInfo.processInfo.thermalState {
        case .nominal: "nominal"
        case .fair: "fair"
        case .serious: "serious"
        case .critical: "critical"
        @unknown default: "unknown"
        }
    }

    static func device() -> [String: Any] {
        var info = utsname()
        uname(&info)
        let machine = withUnsafeBytes(of: &info.machine) { raw in
            String(decoding: raw.prefix { $0 != 0 }, as: UTF8.self)
        }
        return [
            "machine": machine,
            "os": ProcessInfo.processInfo.operatingSystemVersionString,
            "ramMB": mb(ProcessInfo.processInfo.physicalMemory),
            "cores": ProcessInfo.processInfo.activeProcessorCount,
        ]
    }

    static func snapshot(_ label: String) -> [String: Any] {
        let fp = footprint()
        let avail = available()
        return [
            "label": label,
            "footprintMB": mb(fp.current),
            "lifetimePeakMB": mb(fp.lifetimePeak),
            "availableMB": mb(avail),
            "limitMB": mb(fp.current + avail),
            "thermal": thermal(),
        ]
    }
}

/// Polls the footprint every 2 ms on its own thread and keeps the maximum, so
/// each stage gets its own peak rather than the process's lifetime peak.
final class PeakSampler: @unchecked Sendable {
    private let lock = NSLock()
    private var peak: UInt64 = 0
    private var running = true

    init() {
        let thread = Thread { [weak self] in
            while let self, self.isRunning {
                let now = Probe.footprint().current
                self.lock.lock()
                if now > self.peak { self.peak = now }
                self.lock.unlock()
                usleep(2_000)
            }
        }
        thread.qualityOfService = .userInteractive
        thread.start()
    }

    private var isRunning: Bool {
        lock.lock()
        defer { lock.unlock() }
        return running
    }

    /// Peak since the last reset, then starts a new stage.
    func takePeak() -> UInt64 {
        lock.lock()
        defer { lock.unlock() }
        let value = max(peak, Probe.footprint().current)
        peak = 0
        return value
    }

    func stop() {
        lock.lock()
        running = false
        lock.unlock()
    }
}

/// Appends lines to Documents/log.txt and writes result JSON files there.
enum Output {
    static let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]

    static func log(_ line: String) {
        let stamped = "\(ISO8601DateFormatter().string(from: Date())) \(line)\n"
        let url = dir.appendingPathComponent("log.txt")
        if let handle = try? FileHandle(forWritingTo: url) {
            handle.seekToEndOfFile()
            handle.write(Data(stamped.utf8))
            try? handle.close()
        } else {
            try? Data(stamped.utf8).write(to: url)
        }
    }

    static func write(_ name: String, _ object: Any) {
        guard
            let data = try? JSONSerialization.data(
                withJSONObject: object, options: [.prettyPrinted, .sortedKeys])
        else {
            log("could not serialize \(name)")
            return
        }
        do {
            try data.write(to: dir.appendingPathComponent(name), options: .atomic)
        } catch {
            log("write \(name) failed: \(error)")
        }
    }
}
