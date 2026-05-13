#!/usr/bin/env node
import { handleNativeMessage, readNativeMessage, writeNativeMessage } from './host-core.mjs'

try {
  const message = await readNativeMessage(process.stdin)
  const response = await handleNativeMessage(message)
  process.stdout.write(writeNativeMessage(response))
} catch (error) {
  process.stdout.write(
    writeNativeMessage({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    })
  )
  process.exitCode = 1
}
