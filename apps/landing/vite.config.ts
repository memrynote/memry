import { defineConfig, loadEnv, type PluginOption } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

function loadApiEnv(mode: string) {
  const env = loadEnv(mode, __dirname, '')

  for (const [key, value] of Object.entries(env)) {
    process.env[key] ??= value
  }
}

function apiDevProxy(): PluginOption {
  return {
    name: 'api-dev-proxy',
    configureServer(server) {
      server.middlewares.use('/api', async (req, res, next) => {
        const pathName = req.url?.split('?')[0]?.replace(/^\/api\//, '/')
        const apiName = pathName?.match(/^\/([a-z0-9-]+)$/)?.[1]

        if (!apiName) {
          next()
          return
        }

        let body: unknown
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          const chunks: Buffer[] = []
          for await (const chunk of req) chunks.push(chunk as Buffer)

          const rawBody = Buffer.concat(chunks).toString()
          body = rawBody ? JSON.parse(rawBody) : undefined
        }

        const mod = await server.ssrLoadModule(`/api/${apiName}.ts`)
        const vercelReq = { method: req.method, body } as never
        const result = {
          statusCode: 200,
          body: '' as string,
          headers: {} as Record<string, number | string | readonly string[]>
        }
        const vercelRes = {
          status(code: number) {
            result.statusCode = code
            return this
          },
          setHeader(name: string, value: number | string | readonly string[]) {
            result.headers[name] = value
            return this
          },
          json(data: unknown) {
            result.body = JSON.stringify(data)
            return this
          }
        } as never

        await mod.default(vercelReq, vercelRes)

        res.statusCode = result.statusCode
        for (const [name, value] of Object.entries(result.headers)) {
          res.setHeader(name, value)
        }
        res.setHeader('Content-Type', 'application/json')
        res.end(result.body)
      })
    }
  }
}

export default defineConfig(({ mode }) => {
  loadApiEnv(mode)

  return {
    plugins: [react(), tailwindcss(), apiDevProxy()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src')
      }
    },
    define: {
      // Vite only exposes VITE_-prefixed vars; forward Vercel's build-time
      // VERCEL_ENV ('production' | 'preview' | 'development') so the app can
      // tell real production apart from preview deploys, which `MODE` cannot.
      'import.meta.env.VITE_VERCEL_ENV': JSON.stringify(process.env.VERCEL_ENV ?? '')
    },
    build: {
      rollupOptions: {
        output: {
          // Split heavy vendors into separately-cacheable chunks. Static imports keep
          // them in the initial graph, but immutable per-lib caching (see vercel.json)
          // means a deploy that only touches app code reuses these from cache.
          // ponytail: chunk grouping only; deferring these off first paint needs
          // dynamic import() + a hydrateRoot() migration (createRoot replaces the
          // prerendered DOM, so React.lazy would flash a fallback on direct loads).
          manualChunks: {
            'react-vendor': ['react', 'react-dom', 'react-router'],
            motion: ['framer-motion', 'lenis'],
            paddle: ['@paddle/paddle-js'],
            crypto: ['libsodium-wrappers-sumo'],
            icons: ['lucide-react', '@hugeicons/react', '@hugeicons/core-free-icons']
          }
        }
      }
    }
  }
})
