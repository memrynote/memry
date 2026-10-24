/** A harness precondition failed; the test never ran against the wrong app. */
export class HarnessError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'HarnessError'
  }
}
