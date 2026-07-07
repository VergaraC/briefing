/**
 * Briefing feed relay — a private CORS proxy for the news app, on Cloudflare's free tier.
 *
 * Why: the app currently depends on two public proxy services. This relay replaces them
 * with something you own: no rate limits shared with strangers, no third party seeing
 * which feeds you read, and responses cached at Cloudflare's edge for 5 minutes (faster
 * refreshes, gentler on the news sites).
 *
 * Deploy (one time, ~3 minutes, free — no credit card):
 *   1. Create a free account at https://dash.cloudflare.com
 *   2. Workers & Pages → Create → Worker → name it e.g. "briefing-proxy" → Deploy
 *   3. Edit code → replace everything with this file → Deploy
 *   4. Copy the worker URL (https://briefing-proxy.<your-subdomain>.workers.dev)
 *      into MY_PROXY at the top of index.html's script.
 *
 * Only hosts on this list can be fetched, so the relay can't be abused as an open proxy.
 */

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
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const target = new URL(request.url).searchParams.get('url');
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
};
