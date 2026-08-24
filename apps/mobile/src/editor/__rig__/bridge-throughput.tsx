/**
 * RN↔WebView bridge throughput rig (spec 001-mobile-app T011 / R4, G0-d).
 *
 * Minimal WebView speaking the envelope from contracts/webview-bridge.md
 * (v1, sid, seq, msgs; string-only, base64-framed, batched both ends).
 * Protocol: 50 KB doc loaded via `doc-load`, then a scripted 10 keystrokes/s
 * burst for 60 s inside the WebView; each keystroke appends a ~200 B base64
 * frame that is batched (T_flush / B_max) and delivered to RN, which acks.
 * One 5 MB `doc-load` bounds large-payload behaviour.
 *
 * Measures (RELEASE build only — debug messaging is disqualifying):
 *   - WV→RN envelope delivery p95   (target ≤ 100 ms under burst)
 *   - RN-side apply+ack p95
 *   - envelopes/s and msgs/envelope both directions (batching proof:
 *     envelopes/s ≈ 1/T_flush, never ≈ keystroke rate)
 *   - zero dropped / out-of-order seq
 * Tune T_FLUSH_MS / B_MAX_BYTES here; the chosen values graduate into
 * contracts/webview-bridge.md.
 */
import { useCallback, useMemo, useRef, useState, type ReactElement } from 'react'
import { Button, ScrollView, StyleSheet, Text, View } from 'react-native'
import { WebView, type WebViewMessageEvent } from 'react-native-webview'

// Initial values per the contract; tuned by this rig (R4).
export const T_FLUSH_MS = 24
export const B_MAX_BYTES = 256 * 1024

const KEYSTROKES_PER_SECOND = 10
const BURST_SECONDS = 60
const DOC_KB = 50
const LARGE_DOC_MB = 5

interface RigStats {
  envelopesReceived: number
  msgsReceived: number
  keystrokesSent: number
  deliveryP95Ms: number
  applyP95Ms: number
  msgsPerEnvelope: number
  envelopesPerSecond: number
  seqGaps: number
  largeDocLoadMs: number | null
  done: boolean
}

const p95 = (samples: number[]): number => {
  if (samples.length === 0) return 0
  const sorted = [...samples].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]
}

// The WebView half of the rig: batches keystroke frames per the contract and
// timestamps each envelope at send so RN can measure delivery latency.
const buildRigHtml = (): string => `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body>
<div id="status">rig ready</div>
<script>
  var SID = 'wv-' + Math.random().toString(36).slice(2)
  var seq = 0
  var pending = []
  var pendingBytes = 0
  var flushTimer = null
  var T_FLUSH = ${T_FLUSH_MS}
  var B_MAX = ${B_MAX_BYTES}
  var envelopesSent = 0
  var msgsSent = 0

  function post(obj) {
    window.ReactNativeWebView.postMessage(JSON.stringify(obj))
  }

  function flush() {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
    if (pending.length === 0) return
    envelopesSent += 1
    msgsSent += pending.length
    post({ v: 1, sid: SID, seq: ++seq, sentAt: Date.now(), msgs: pending })
    pending = []
    pendingBytes = 0
  }

  function enqueue(msg, bytes) {
    pending.push(msg)
    pendingBytes += bytes
    if (pendingBytes >= B_MAX) { flush(); return }
    if (!flushTimer) flushTimer = setTimeout(flush, T_FLUSH)
  }

  // ~200 B pseudo Yjs frame per keystroke, base64-framed per the contract.
  function keystrokeFrame(i) {
    var raw = ''
    for (var j = 0; j < 150; j++) raw += String.fromCharCode(33 + ((i + j) % 90))
    return btoa(raw)
  }

  var burstTimer = null
  var keystrokes = 0

  function startBurst(totalKeystrokes, intervalMs) {
    stopBurst()
    burstTimer = setInterval(function () {
      keystrokes += 1
      // Local render first — the bridge is off the critical render path.
      document.getElementById('status').textContent = 'keystroke ' + keystrokes
      enqueue({ type: 'y-update', docId: 'rig-doc', updatesB64: [keystrokeFrame(keystrokes)], k: keystrokes }, 200)
      if (keystrokes >= totalKeystrokes) {
        stopBurst()
        flush()
        post({ v: 1, sid: SID, seq: ++seq, sentAt: Date.now(), msgs: [{ type: 'burst-done', keystrokes: keystrokes, envelopesSent: envelopesSent, msgsSent: msgsSent }] })
      }
    }, intervalMs)
  }

  function stopBurst() {
    if (burstTimer) { clearInterval(burstTimer); burstTimer = null }
  }

  window.addEventListener('message', function (event) { handle(event.data) })
  document.addEventListener('message', function (event) { handle(event.data) })

  function handle(data) {
    var envelope
    try { envelope = JSON.parse(data) } catch (e) { return }
    if (!envelope || envelope.v !== 1) return
    for (var i = 0; i < envelope.msgs.length; i++) {
      var msg = envelope.msgs[i]
      if (msg.type === 'doc-load') {
        var loadedBytes = msg.stateB64.length
        post({ v: 1, sid: SID, seq: ++seq, sentAt: Date.now(), msgs: [{ type: 'doc-loaded', bytes: loadedBytes, reqId: msg.reqId }] })
      } else if (msg.type === 'exec' && msg.cmd === 'start-burst') {
        keystrokes = 0
        startBurst(msg.total, msg.intervalMs)
      } else if (msg.type === 'exec' && msg.cmd === 'flush') {
        flush()
      }
    }
  }

  post({ v: 1, sid: SID, seq: ++seq, sentAt: Date.now(), msgs: [{ type: 'ready', protocolV: 1, schemaV: 'rig' }] })
</script>
</body></html>`

const makeBase64Doc = (bytes: number): string => {
  const chunk = 'TWVtcnkgcGFyaXR5IGRvYyBjaHVuayAtIHJlcGVhdGFibGUu' // fixed 48-char chunk
  return chunk.repeat(Math.ceil(bytes / chunk.length)).slice(0, bytes)
}

export const BridgeThroughputRig = (): ReactElement => {
  const webViewRef = useRef<WebView>(null)
  const rnSeq = useRef(0)
  const lastWvSeq = useRef(0)
  const deliverySamples = useRef<number[]>([])
  const applySamples = useRef<number[]>([])
  const envelopeCount = useRef(0)
  const msgCount = useRef(0)
  const seqGaps = useRef(0)
  const burstStartedAt = useRef(0)
  const largeDocSentAt = useRef(0)
  const [stats, setStats] = useState<RigStats | null>(null)

  const html = useMemo(() => buildRigHtml(), [])

  const send = useCallback((msgs: object[]) => {
    const envelope = JSON.stringify({ v: 1, sid: 'rn-rig', seq: ++rnSeq.current, msgs })
    webViewRef.current?.injectJavaScript(
      `window.dispatchEvent(new MessageEvent('message', { data: ${JSON.stringify(envelope)} })); true;`
    )
  }, [])

  const startRun = useCallback(() => {
    deliverySamples.current = []
    applySamples.current = []
    envelopeCount.current = 0
    msgCount.current = 0
    seqGaps.current = 0
    lastWvSeq.current = 0
    setStats(null)
    burstStartedAt.current = performance.now()
    send([
      {
        type: 'doc-load',
        docId: 'rig-doc',
        stateB64: makeBase64Doc(DOC_KB * 1024),
        reqId: 'load-50kb'
      },
      {
        type: 'exec',
        cmd: 'start-burst',
        total: KEYSTROKES_PER_SECOND * BURST_SECONDS,
        intervalMs: 1000 / KEYSTROKES_PER_SECOND
      }
    ])
  }, [send])

  const sendLargeDoc = useCallback(() => {
    largeDocSentAt.current = performance.now()
    send([
      {
        type: 'doc-load',
        docId: 'rig-large',
        stateB64: makeBase64Doc(LARGE_DOC_MB * 1024 * 1024),
        reqId: 'load-5mb'
      }
    ])
  }, [send])

  const onMessage = useCallback((event: WebViewMessageEvent) => {
    const receivedAt = Date.now()
    const applyStart = performance.now()
    const envelope = JSON.parse(event.nativeEvent.data) as {
      v: number
      sid: string
      seq: number
      sentAt: number
      msgs: Record<string, unknown>[]
    }
    if (envelope.v !== 1) return

    if (lastWvSeq.current > 0 && envelope.seq !== lastWvSeq.current + 1) {
      seqGaps.current += 1
    }
    lastWvSeq.current = envelope.seq

    envelopeCount.current += 1
    msgCount.current += envelope.msgs.length
    deliverySamples.current.push(receivedAt - envelope.sentAt)

    let burstDone = false
    let largeDocMs: number | null = null
    for (const msg of envelope.msgs) {
      if (msg.type === 'burst-done') burstDone = true
      if (msg.type === 'doc-loaded' && msg.reqId === 'load-5mb') {
        largeDocMs = performance.now() - largeDocSentAt.current
      }
    }
    applySamples.current.push(performance.now() - applyStart)

    if (burstDone || largeDocMs !== null) {
      const elapsedS = (performance.now() - burstStartedAt.current) / 1000
      setStats((prev) => ({
        envelopesReceived: envelopeCount.current,
        msgsReceived: msgCount.current,
        keystrokesSent: KEYSTROKES_PER_SECOND * BURST_SECONDS,
        deliveryP95Ms: p95(deliverySamples.current),
        applyP95Ms: p95(applySamples.current),
        msgsPerEnvelope: msgCount.current / Math.max(1, envelopeCount.current),
        envelopesPerSecond: envelopeCount.current / Math.max(1, elapsedS),
        seqGaps: seqGaps.current,
        largeDocLoadMs: largeDocMs ?? prev?.largeDocLoadMs ?? null,
        done: burstDone || (prev?.done ?? false)
      }))
    }
  }, [])

  return (
    <View style={styles.container}>
      <View style={styles.controls}>
        <Button
          title={`Run burst (${KEYSTROKES_PER_SECOND}/s × ${BURST_SECONDS}s, ${DOC_KB} KB doc)`}
          onPress={startRun}
        />
        <Button title={`Load ${LARGE_DOC_MB} MB doc`} onPress={sendLargeDoc} />
      </View>
      {stats ? (
        <ScrollView style={styles.stats}>
          <Text accessibilityRole="summary" style={styles.statLine}>
            {[
              `envelopes: ${stats.envelopesReceived}`,
              `msgs: ${stats.msgsReceived} (keystrokes sent: ${stats.keystrokesSent})`,
              `delivery p95: ${stats.deliveryP95Ms.toFixed(1)} ms (target ≤ 100)`,
              `apply p95: ${stats.applyP95Ms.toFixed(2)} ms`,
              `msgs/envelope: ${stats.msgsPerEnvelope.toFixed(1)} (batching proof: must be > 1)`,
              `envelopes/s: ${stats.envelopesPerSecond.toFixed(1)} (≈ ${(1000 / T_FLUSH_MS).toFixed(0)} = 1/T_flush; ${KEYSTROKES_PER_SECOND} = per-keystroke DEFECT)`,
              `seq gaps: ${stats.seqGaps} (must be 0)`,
              `5 MB doc-load: ${stats.largeDocLoadMs === null ? 'not run' : `${stats.largeDocLoadMs.toFixed(0)} ms`}`,
              stats.done ? 'BURST COMPLETE' : 'running…'
            ].join('\n')}
          </Text>
        </ScrollView>
      ) : null}
      <WebView
        ref={webViewRef}
        source={{ html }}
        onMessage={onMessage}
        style={styles.webview}
        javaScriptEnabled
        originWhitelist={['*']}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  controls: { gap: 8, padding: 12 },
  stats: { maxHeight: 260, paddingHorizontal: 12 },
  statLine: { fontFamily: 'Menlo', fontSize: 12 },
  webview: { flex: 1 }
})

export default BridgeThroughputRig
