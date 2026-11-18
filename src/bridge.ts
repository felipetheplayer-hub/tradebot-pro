import express from 'express';
import { timingSafeEqual } from 'node:crypto';

export function validBridgeKey(actual: string | undefined, expected: string) {
  if (!actual || Buffer.byteLength(actual) !== Buffer.byteLength(expected)) return false;
  return timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

// Render only relays HTTPS. OAuth/session ownership, execution and storage stay on the VPS.
export function createBridge(base: string, key: string, fetcher = fetch) {
  const upstream = new URL(base);
  if (upstream.protocol !== 'https:' || upstream.username || upstream.password || upstream.search ||
      upstream.hash || !upstream.pathname.endsWith('/') || key.length < 32) {
    throw new Error('Configuração da conexão VPS inválida.');
  }
  const app = express();
  app.disable('x-powered-by');
  app.locals.shutdown = async () => {};
  app.get('/healthz', (_req, res) => res.json({ mode: 'VPS_BRIDGE' }));
  app.use(express.raw({type: () => true, limit: '4kb'}));
  app.use(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('X-Content-Type-Options', 'nosniff');
    if (!['GET', 'HEAD', 'POST'].includes(req.method)) return res.sendStatus(405);
    const target = new URL(upstream.href + req.originalUrl.replace(/^\//, ''));
    if (target.origin !== upstream.origin || !target.pathname.startsWith(upstream.pathname) ||
        req.originalUrl.includes('\\')) return res.sendStatus(400);
    const headers = new Headers({'X-Tradebot-Bridge': key});
    for (const name of ['cookie','origin','content-type']) {
      const value = req.get(name);
      if (value) headers.set(name,value);
    }
    try {
      const response = await fetcher(target.href, {
        method: req.method, headers, redirect: 'manual', signal: AbortSignal.timeout(20000),
        body: req.method === 'POST' && req.body?.length ? new Uint8Array(req.body) : undefined,
      });
      for (const name of ['content-type','location']) {
        const value = response.headers.get(name);
        if (value) res.set(name,value);
      }
      for (const cookie of response.headers.getSetCookie()) res.append('Set-Cookie',cookie);
      const body = await response.arrayBuffer();
      if (body.byteLength > 2 * 1024 * 1024) return res.sendStatus(502);
      return res.status(response.status).send(Buffer.from(body));
    } catch {
      // Never log upstream URLs (OAuth codes) or credentials, and never retry a POST.
      return res.status(502).json({error:'A VPS está indisponível. Nenhuma solicitação será repetida automaticamente.'});
    }
  });
  return app;
}
