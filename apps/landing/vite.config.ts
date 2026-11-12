import type { ServerResponse } from 'node:http'
import { defineConfig, loadEnv, type Connect, type PluginOption, type ViteDevServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

function loadApiEnv(mode: string) {
  const env = loadEnv(mode, __dirname, '')

  for (const [key, value] of Object.entries(env)) {
    process.env[key] ??= value
  }
}

async function handleApiRequest(
  server: ViteDevServer,
  req: Connect.IncomingMessage,
  res: ServerResponse,
  next: Connect.NextFunction
): Promise<void> {
  const pathName = req.url?.split('?')[0]?.replace(/^\/api\//, '/')
  const apiName = pathName?.match(/^\/([a-z0-9-]+)$/)?.[1]

  if (!apiName) {
    next()
    return
  }

  let body: unknown
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- an IncomingMessage without an encoding yields Buffers; its async iterator is typed any
      chunks.push(chunk as Buffer)
    }

    const rawBody = Buffer.concat(chunks).toString()
    body = rawBody ? JSON.parse(rawBody) : undefined
  }

  const mod = await server.ssrLoadModule(`/api/${apiName}.ts`)
  // The parts of VercelRequest/VercelResponse the handlers in api/ use: download.ts reads
  // req.query and answers with res.redirect.
  const query = Object.fromEntries(new URL(req.url ?? '/', 'http://localhost').searchParams)
  const vercelReq = { method: req.method, body, query }
  const result = {
    statusCode: 200,
    body: '' as string,
    redirectTo: null as string | null,
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
    },
    redirect(code: number, url: string) {
      result.statusCode = code
      result.redirectTo = url
      return this
    }
  }

  await mod.default(vercelReq, vercelRes)

  res.statusCode = result.statusCode
  for (const [name, value] of Object.entries(result.headers)) {
    res.setHeader(name, value)
  }
  if (result.redirectTo !== null) {
    res.setHeader('Location', result.redirectTo)
    res.end()
    return
  }
  res.setHeader('Content-Type', 'application/json')
  res.end(result.body)
}

function apiDevProxy(): PluginOption {
  return {
    name: 'api-dev-proxy',
    configureServer(server) {
      server.middlewares.use('/api', (req, res, next) => {
        void handleApiRequest(server, req, res, next)
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
      // scripts/prerender.ts reads this to emit <link rel="modulepreload"> for the boot
      // chunk and its dependencies. main.tsx imports boot dynamically, so Vite has no
      // static entry graph to write those links from, and without them the whole app
      // would only start downloading after the first paint.
      manifest: true,
      rollupOptions: {
        output: {
          // Split heavy vendors into separately-cacheable chunks, so a deploy that
          // only touches app code reuses them from the immutable cache (see
          // vercel.json). posthog, paddle and crypto are reached through dynamic
          // import() at their call sites, so grouping them here keeps them as
          // named chunks while leaving them out of the entry graph entirely.
          // react-vendor, motion and icons stay static: they render first paint.
          manualChunks: {
            // react-dom/client, not the react-dom entry, is what the app imports, and
            // a bare 'react-dom' id here never matched it — the whole renderer was
            // landing in the app chunk and being re-downloaded on every deploy.
            'react-vendor': ['react', 'react-dom', 'react-dom/client', 'react-router'],
            motion: ['motion/react', 'lenis'],
            paddle: ['@paddle/paddle-js'],
            // Must stay the module.full.no-external subpath: the bare specifier
            // resolves to the lean bundle that lazy-loads rrweb as an external
            // script, which disable_external_dependency_loading blocks, silently
            // killing session replay. See src/lib/analytics.ts.
            posthog: ['posthog-js/dist/module.full.no-external'],
            crypto: ['libsodium-wrappers-sumo'],
            icons: ['lucide-react', '@hugeicons/react', '@hugeicons/core-free-icons']
          }
        }
      }
    }
  }
})
