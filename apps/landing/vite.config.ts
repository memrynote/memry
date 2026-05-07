import { defineConfig, type PluginOption } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

function apiDevProxy(): PluginOption {
  return {
    name: 'api-dev-proxy',
    configureServer(server) {
      server.middlewares.use('/api/waitlist', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end(JSON.stringify({ error: 'Method not allowed' }))
          return
        }

        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(chunk as Buffer)
        const body = JSON.parse(Buffer.concat(chunks).toString())

        const mod = await server.ssrLoadModule('/api/waitlist.ts')
        const vercelReq = { method: 'POST', body } as never
        const result = { statusCode: 200, body: '' as string }
        const vercelRes = {
          status(code: number) {
            result.statusCode = code
            return this
          },
          json(data: unknown) {
            result.body = JSON.stringify(data)
            return this
          }
        } as never

        await mod.default(vercelReq, vercelRes)

        res.statusCode = result.statusCode
        res.setHeader('Content-Type', 'application/json')
        res.end(result.body)
      })
    }
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), apiDevProxy()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src')
    }
  }
})
