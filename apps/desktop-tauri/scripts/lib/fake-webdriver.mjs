// A fake W3C WebDriver server for the script tests. `handler(method, path, body)` answers with
// the `value` of the response, or `{ status, value }` for a failure; every request is recorded.
import { createServer } from 'node:http'

export async function startFakeWebDriver(handler) {
  const requests = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : undefined
      requests.push({ method: req.method, path: req.url, body })
      const answer = handler(req.method, req.url, body)
      const failed = answer && typeof answer === 'object' && 'status' in answer
      res.statusCode = failed ? answer.status : 200
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ value: failed ? answer.value : answer }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    close: () => new Promise((resolve) => server.close(resolve))
  }
}
