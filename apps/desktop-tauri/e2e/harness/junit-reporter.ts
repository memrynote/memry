import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import WDIOReporter, { type RunnerStats, type TestStats } from '@wdio/reporter'

/**
 * Writes one JUnit file per worker from the test events. `@wdio/junit-reporter` groups tests by
 * mocha suite, and a spec whose tests sit at the top of the file, as ported Playwright specs do,
 * has no suite, so that reporter writes `tests="0"`.
 */
const escapeXml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // eslint-disable-next-line no-control-regex -- XML 1.0 forbids these characters
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')

export default class E2eJunitReporter extends WDIOReporter {
  private readonly cases: string[] = []
  private failedCount = 0
  private skippedCount = 0
  private total = 0
  private elapsed = 0

  constructor(private readonly reporterOptions: { outputDir: string }) {
    super({ ...reporterOptions, stdout: false })
  }

  private add(test: TestStats, body: string): void {
    const time = (test._duration / 1000).toFixed(3)
    this.elapsed += test._duration / 1000
    this.total += 1
    this.cases.push(
      `    <testcase classname="${escapeXml(test.parent || 'e2e')}" name="${escapeXml(test.title)}" time="${time}">${body}</testcase>`
    )
  }

  onTestPass(test: TestStats): void {
    this.add(test, '')
  }

  onTestFail(test: TestStats): void {
    this.failedCount += 1
    const error = test.error
    const message = escapeXml(error?.message ?? 'failed')
    this.add(
      test,
      `\n      <failure message="${message}" type="${escapeXml(error?.name ?? 'Error')}">${escapeXml(error?.stack ?? message)}</failure>\n    `
    )
  }

  onTestSkip(test: TestStats): void {
    this.skippedCount += 1
    this.add(test, '<skipped/>')
  }

  onRunnerEnd(runner: RunnerStats): void {
    const spec = escapeXml(
      (runner.specs[0] ?? '').startsWith('file:')
        ? fileURLToPath(runner.specs[0])
        : (runner.specs[0] ?? '')
    )
    const suite = `  <testsuite name="${spec}" tests="${this.total}" failures="${this.failedCount}" errors="0" skipped="${this.skippedCount}" time="${this.elapsed.toFixed(3)}">\n${this.cases.join('\n')}\n  </testsuite>`
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites tests="${this.total}" failures="${this.failedCount}" errors="0" skipped="${this.skippedCount}" time="${this.elapsed.toFixed(3)}">\n${suite}\n</testsuites>\n`
    mkdirSync(this.reporterOptions.outputDir, { recursive: true })
    writeFileSync(
      join(
        this.reporterOptions.outputDir,
        `results-${runner.cid}-${basename(spec, '.e2e.ts')}.xml`
      ),
      xml
    )
  }
}
