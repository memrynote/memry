import Foundation
import MemryCore
import UIKit

/// The #4437 measurements. Each launch runs one mode in a fresh process
/// (`--mode load|parity|corpus|background`, `--threads N`, `--notes N`), so a
/// stage's memory is never inflated by an earlier mode.
enum Bench {
    static let query = "task: search result | query: notes from the budget meeting last week"

    static func argument(_ name: String, _ fallback: String) -> String {
        let args = ProcessInfo.processInfo.arguments
        guard let at = args.firstIndex(of: name), at + 1 < args.count else { return fallback }
        return args[at + 1]
    }

    static var modelDir: String { Output.dir.appendingPathComponent("model").path }

    /// A note long enough that its head window is exactly 4000 characters.
    static func fullWindow() -> String {
        var corpus = Corpus(seed: 7)
        var body = ""
        while body.count < 9_000 { body += corpus.note().content + " " }
        return spikeEmbeddingChunks(title: "Quarterly planning", content: body)[0]
    }

    static func median(_ values: [Double]) -> Double {
        let sorted = values.sorted()
        return sorted.isEmpty ? 0 : sorted[sorted.count / 2]
    }

    static func percentile(_ values: [Double], _ p: Double) -> Double {
        let sorted = values.sorted()
        return sorted.isEmpty ? 0 : sorted[min(sorted.count - 1, Int(Double(sorted.count) * p))]
    }

    static func load(threads: UInt32, sampler: PeakSampler) throws -> (SpikeEmbedder, [String: Any]) {
        _ = sampler.takePeak()
        let started = Date()
        let embedder = try SpikeEmbedder.load(modelDir: modelDir, intraThreads: threads)
        let timing = embedder.loadTiming()
        return (embedder, [
            "wallMs": Date().timeIntervalSince(started) * 1000,
            "tokenizerMs": timing.tokenizerMs,
            "sessionMs": timing.sessionMs,
            "peakMB": Probe.mb(sampler.takePeak()),
            "after": Probe.snapshot("after load"),
        ])
    }

    static func stage(_ embedder: SpikeEmbedder, _ text: String, runs: Int, sampler: PeakSampler) throws
        -> [String: Any]
    {
        _ = sampler.takePeak()
        let first = try embedder.embed(text: text)
        let firstPeak = sampler.takePeak()
        var infer: [Double] = []
        var tokenize: [Double] = []
        for _ in 0..<runs {
            let result = try embedder.embed(text: text)
            infer.append(result.inferMs)
            tokenize.append(result.tokenizeMs)
        }
        return [
            "chars": text.count,
            "tokens": first.tokens,
            "firstInferMs": first.inferMs,
            "firstTokenizeMs": first.tokenizeMs,
            "firstPeakMB": Probe.mb(firstPeak),
            "runs": runs,
            "medianInferMs": median(infer),
            "p90InferMs": percentile(infer, 0.9),
            "medianTokenizeMs": median(tokenize),
            "repeatPeakMB": Probe.mb(sampler.takePeak()),
            "after": Probe.snapshot("after stage"),
        ]
    }

    @MainActor static func run(status: @escaping @MainActor (String) -> Void) async {
        let mode = argument("--mode", "load")
        let threads = UInt32(argument("--threads", "2")) ?? 2
        Output.log("start mode=\(mode) threads=\(threads)")
        let battery = Probe.battery()
        let header: [String: Any] = [
            "mode": mode, "threads": threads, "device": Probe.device(), "batteryStart": battery,
            "baseline": Probe.snapshot("baseline"),
        ]
        status("running \(mode)…")
        let sampler = PeakSampler()
        do {
            switch mode {
            case "load":
                let result = try await Task.detached { try loadMode(threads: threads, sampler: sampler) }.value
                Output.write("result-load-t\(threads).json", header.merging(result) { $1 })
            case "parity":
                let result = try await Task.detached { try parityMode(threads: threads) }.value
                Output.write("result-parity.json", header.merging(result) { $1 })
            case "corpus":
                UIApplication.shared.isIdleTimerDisabled = true
                let notes = Int(argument("--notes", "1000")) ?? 1000
                let result = try await Task.detached {
                    try corpusMode(threads: threads, notes: notes, sampler: sampler)
                }.value
                var merged = header.merging(result) { $1 }
                merged["batteryEnd"] = Probe.battery()
                Output.write("result-corpus-t\(threads).json", merged)
                UIApplication.shared.isIdleTimerDisabled = false
            case "background":
                let result = try await backgroundMode(threads: threads, sampler: sampler)
                Output.write("result-background.json", header.merging(result) { $1 })
            default:
                Output.log("unknown mode \(mode)")
            }
            Output.log("done mode=\(mode)")
            status("done \(mode)")
        } catch {
            Output.log("failed mode=\(mode): \(error)")
            Output.write("result-\(mode)-error.json", header.merging(["error": "\(error)"]) { $1 })
            status("failed \(mode): \(error)")
        }
        sampler.stop()
    }

    static func loadMode(threads: UInt32, sampler: PeakSampler) throws -> [String: Any] {
        let window = fullWindow()
        let (embedder, load) = try load(threads: threads, sampler: sampler)
        let query = try stage(embedder, Self.query, runs: 20, sampler: sampler)
        let doc = try stage(embedder, window, runs: 5, sampler: sampler)
        return [
            "load": load, "query": query, "window": doc,
            "end": Probe.snapshot("end"),
        ]
    }

    /// Embeds `Documents/parity-inputs.json` (`[{id, text}]`, shaped by desktop).
    static func parityMode(threads: UInt32) throws -> [String: Any] {
        let data = try Data(contentsOf: Output.dir.appendingPathComponent("parity-inputs.json"))
        let inputs = try JSONSerialization.jsonObject(with: data) as? [[String: String]] ?? []
        let embedder = try SpikeEmbedder.load(modelDir: modelDir, intraThreads: threads)
        var vectors: [[String: Any]] = []
        for input in inputs {
            let result = try embedder.embed(text: input["text"] ?? "")
            vectors.append(["id": input["id"] ?? "", "tokens": result.tokens, "vector": result.vector])
        }
        return ["vectors": vectors]
    }

    static func corpusMode(threads: UInt32, notes: Int, sampler: PeakSampler) throws -> [String: Any] {
        var corpus = Corpus(seed: 4437)
        let (embedder, load) = try load(threads: threads, sampler: sampler)
        _ = sampler.takePeak()
        let started = Date()
        var windows = 0
        var chars = 0
        var tokens = 0
        var windowMs: [Double] = []
        var thermal: [String: Int] = [:]
        for index in 0..<notes {
            let note = corpus.note()
            for window in spikeEmbeddingChunks(title: note.title, content: note.content) {
                let result = try embedder.embed(text: window)
                windows += 1
                chars += window.count
                tokens += Int(result.tokens)
                windowMs.append(result.tokenizeMs + result.inferMs)
            }
            thermal[Probe.thermal(), default: 0] += 1
            if index % 50 == 49 {
                Output.log(
                    "corpus \(index + 1)/\(notes) windows=\(windows) "
                        + "elapsed=\(Int(Date().timeIntervalSince(started)))s thermal=\(Probe.thermal())")
            }
        }
        return [
            "load": load,
            "notes": notes, "windows": windows, "chars": chars, "tokens": tokens,
            "wallSeconds": Date().timeIntervalSince(started),
            "medianWindowMs": median(windowMs), "p90WindowMs": percentile(windowMs, 0.9),
            "peakMB": Probe.mb(sampler.takePeak()),
            "thermalNotes": thermal,
            "end": Probe.snapshot("end"),
        ]
    }

    /// Loads the model, then waits to be backgrounded (the harness launches
    /// another app) and embeds one full window inside a background task.
    @MainActor static func backgroundMode(threads: UInt32, sampler: PeakSampler) async throws
        -> [String: Any]
    {
        let window = fullWindow()
        let (embedder, load) = try await Task.detached { try load(threads: threads, sampler: sampler) }.value
        let foreground = Probe.snapshot("foreground, model loaded")
        let task = UIApplication.shared.beginBackgroundTask(withName: "embed-spike")
        Output.log("model loaded, waiting for background")
        while UIApplication.shared.applicationState != .background {
            try await Task.sleep(for: .milliseconds(200))
        }
        let entered = Probe.snapshot("background, before embed")
        Output.log("in background, embedding")
        let doc = try await Task.detached { try stage(embedder, window, runs: 2, sampler: sampler) }.value
        let after = Probe.snapshot("background, after embed")
        UIApplication.shared.endBackgroundTask(task)
        return ["load": load, "foreground": foreground, "background": entered, "window": doc, "after": after]
    }
}
