/**
 * Briefing worker — feed relay + daily digest push, on Cloudflare's free tier.
 *
 * Does three jobs:
 *   1. GET /?url=<feed>     — private CORS relay for the app's RSS fetches (allowlisted hosts,
 *                             5-minute edge cache). Replaces the public proxy services.
 *   2. POST /subscribe      — stores a device's push subscription in KV (POST /unsubscribe removes it).
 *   3. Cron (07:00 São Paulo) — sends a web push to every subscribed device; the app's service
 *                             worker shows the "morning briefing" notification.
 *
 * Setup (Cloudflare dashboard, all free):
 *   - Create Worker, paste this file.
 *   - KV namespace bound as `SUBS` (Settings → Bindings → KV Namespace).
 *   - Secret `VAPID_PRIVATE_KEY` = the private JWK generated with the app.
 *   - Cron trigger: 0 10 * * *  (10:00 UTC = 07:00 America/Sao_Paulo).
 */

const PUSH_PUBLIC_KEY = 'BJi6Ots5KNrucEgMRLghdNPK9FZ6xyFhPrw_C-rB43Oafi2rXHRcOD6Q3YNW_YHvqb0kNGp9RG_UsWrKbjWgQXw';
const VAPID_SUBJECT = 'mailto:victor.vergara@trela.com.br';

const ALLOWED_HOSTS = [
  'aljazeera.com',
  'bbci.co.uk',
  'rss.cnn.com',
  'techcrunch.com',
  'theverge.com',
  'arstechnica.com',
  'hnrss.org',
  'search.cnbc.com',
  'braziljournal.com',
  'infomoney.com.br',
  'bloomberglinea.com.br',
  'moneytimes.com.br',
  'feeds.content.dowjones.io',
  'g1.globo.com',
  'pox.globo.com',
  'agenciabrasil.ebc.com.br',
  'cnnbrasil.com.br',
  'estadao.com.br',
  'news.crunchbase.com',
  'startupi.com.br',
  'neofeed.com.br',
  'startups.com.br',
  'feeds.folha.uol.com.br',
  'rss.uol.com.br',
];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function subKey(endpoint) {
  return b64u(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint)));
}

// VAPID auth for a payload-less push (no message encryption needed — the SW builds the notification).
async function vapidAuth(endpoint, env) {
  const enc = o => b64u(new TextEncoder().encode(JSON.stringify(o)));
  const unsigned = enc({ typ: 'JWT', alg: 'ES256' }) + '.' + enc({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: VAPID_SUBJECT,
  });
  const key = await crypto.subtle.importKey('jwk', JSON.parse(env.VAPID_PRIVATE_KEY),
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key,
    new TextEncoder().encode(unsigned));
  return `vapid t=${unsigned}.${b64u(sig)}, k=${PUSH_PUBLIC_KEY}`;
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(request.url);

    if (url.pathname === '/subscribe' && request.method === 'POST') {
      if (!env.SUBS) return new Response('KV not configured', { status: 503, headers: CORS });
      const sub = await request.json().catch(() => null);
      if (!sub?.endpoint?.startsWith('https://')) return new Response('bad subscription', { status: 400, headers: CORS });
      await env.SUBS.put(await subKey(sub.endpoint), JSON.stringify(sub));
      return new Response('subscribed', { status: 201, headers: CORS });
    }

    if (url.pathname === '/unsubscribe' && request.method === 'POST') {
      if (!env.SUBS) return new Response('KV not configured', { status: 503, headers: CORS });
      const body = await request.json().catch(() => null);
      if (body?.endpoint) await env.SUBS.delete(await subKey(body.endpoint));
      return new Response('unsubscribed', { headers: CORS });
    }

    // Feed relay
    const target = url.searchParams.get('url');
    if (!target) return new Response('missing ?url=', { status: 400, headers: CORS });
    let host;
    try { host = new URL(target).hostname; } catch (e) {
      return new Response('bad url', { status: 400, headers: CORS });
    }
    if (!ALLOWED_HOSTS.some(h => host === h || host.endsWith('.' + h))) {
      return new Response('host not allowed', { status: 403, headers: CORS });
    }
    const upstream = await fetch(target, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BriefingReader/1.0)' },
      cf: { cacheTtl: 300, cacheEverything: true }, // 5-minute edge cache
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        ...CORS,
        'Content-Type': upstream.headers.get('Content-Type') || 'application/xml; charset=utf-8',
        'Cache-Control': 'public, max-age=300',
      },
    });
  },

  // Morning digest: ping every subscribed device; drop subscriptions push services report as gone.
  async scheduled(event, env) {
    if (!env.SUBS || !env.VAPID_PRIVATE_KEY) return;
    const list = await env.SUBS.list();
    for (const { name } of list.keys) {
      try {
        const sub = JSON.parse(await env.SUBS.get(name));
        const res = await fetch(sub.endpoint, {
          method: 'POST',
          headers: {
            Authorization: await vapidAuth(sub.endpoint, env),
            TTL: '43200',
            Urgency: 'normal',
            'Content-Length': '0',
          },
        });
        if (res.status === 404 || res.status === 410) await env.SUBS.delete(name);
      } catch (e) { /* keep going for other devices */ }
    }
  },
};
