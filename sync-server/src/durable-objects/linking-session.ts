import { DurableObject } from 'cloudflare:workers'

type SessionStatus = 'pending' | 'scanned' | 'approved' | 'completed' | 'expired'

interface SessionMeta {
  sessionId: string
  userId: string
  initiatorDeviceId: string
  status: SessionStatus
  expiresAt: number
}

export class LinkingSession extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    switch (url.pathname) {
      case '/create':
        return this.handleCreate(request)
      case '/scan':
        return this.handleTransition(request, 'scanned')
      case '/approve':
        return this.handleTransition(request, 'approved')
      case '/complete':
        return this.handleTransition(request, 'completed')
      case '/status':
        return this.handleStatus()
      default:
        return new Response('Not found', { status: 404 })
    }
  }

  private async handleCreate(request: Request): Promise<Response> {
    const body: {
      sessionId: string
      userId: string
      initiatorDeviceId: string
      expiresAt: number
    } = await request.json()

    const meta: SessionMeta = {
      sessionId: body.sessionId,
      userId: body.userId,
      initiatorDeviceId: body.initiatorDeviceId,
      status: 'pending',
      expiresAt: body.expiresAt
    }

    await this.ctx.storage.put('meta', meta)
    await this.ctx.storage.setAlarm(body.expiresAt * 1000)

    return Response.json({ ok: true })
  }

  private async handleTransition(_request: Request, newStatus: SessionStatus): Promise<Response> {
    const meta = await this.ctx.storage.get<SessionMeta>('meta')
    if (!meta) {
      return Response.json({ error: 'Session not found in DO' }, { status: 404 })
    }

    meta.status = newStatus
    await this.ctx.storage.put('meta', meta)

    return Response.json({
      ok: true,
      userId: meta.userId,
      initiatorDeviceId: meta.initiatorDeviceId
    })
  }

  private async handleStatus(): Promise<Response> {
    const meta = await this.ctx.storage.get<SessionMeta>('meta')
    if (!meta) {
      return Response.json({ status: 'expired', expiresAt: null })
    }

    const now = Math.floor(Date.now() / 1000)
    if (meta.expiresAt < now) {
      return Response.json({ status: 'expired', expiresAt: meta.expiresAt })
    }

    return Response.json({ status: meta.status, expiresAt: meta.expiresAt })
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll()
  }
}
