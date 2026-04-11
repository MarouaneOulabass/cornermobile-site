/**
 * Corner Mobile — Cloudflare Worker (API Proxy sécurisé)
 *
 * La clé API Anthropic est côté serveur, jamais exposée au client.
 *
 * Déploiement :
 * 1. Cloudflare Dashboard > Workers & Pages > Create Worker
 * 2. Coller ce code
 * 3. Settings > Variables > Ajouter : ANTHROPIC_API_KEY = sk-ant-...
 * 4. Deploy
 * 5. Noter l'URL (ex: corner-chat.votre-compte.workers.dev)
 */

const ALLOWED_ORIGINS = [
  'https://cornermobile.ma',
  'http://cornermobile.ma',
  'https://www.cornermobile.ma',
  'https://marouaneoulabass.github.io',
  'http://localhost',
  'http://127.0.0.1',
];

const RATE_LIMIT = new Map(); // IP -> { count, resetAt }
const MAX_REQUESTS_PER_MINUTE = 10;

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const corsOrigin = ALLOWED_ORIGINS.find(o => origin.startsWith(o)) ? origin : ALLOWED_ORIGINS[0];

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': corsOrigin,
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
        }
      });
    }

    if (request.method !== 'POST') {
      return jsonResponse({ error: 'POST only' }, 405, corsOrigin);
    }

    // Rate limiting by IP
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const now = Date.now();
    const limit = RATE_LIMIT.get(ip);
    if (limit && limit.resetAt > now) {
      if (limit.count >= MAX_REQUESTS_PER_MINUTE) {
        return jsonResponse({ error: 'Trop de requêtes. Réessayez dans quelques secondes.' }, 429, corsOrigin);
      }
      limit.count++;
    } else {
      RATE_LIMIT.set(ip, { count: 1, resetAt: now + 60000 });
    }

    // Clean old entries periodically
    if (RATE_LIMIT.size > 1000) {
      for (const [k, v] of RATE_LIMIT) { if (v.resetAt < now) RATE_LIMIT.delete(k); }
    }

    try {
      const body = await request.json();

      // Validate input
      if (!body.messages || !Array.isArray(body.messages)) {
        return jsonResponse({ error: 'messages array required' }, 400, corsOrigin);
      }
      if (body.messages.length > 20) {
        body.messages = body.messages.slice(-20);
      }

      // Call Anthropic API with server-side key
      const apiKey = env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        return jsonResponse({ error: 'API key not configured on server' }, 500, corsOrigin);
      }

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: body.model || 'claude-sonnet-4-20250514',
          max_tokens: body.max_tokens || 800,
          system: body.system || '',
          messages: body.messages,
        })
      });

      const data = await response.json();
      return jsonResponse(data, response.status, corsOrigin);

    } catch (e) {
      return jsonResponse({ error: 'Server error: ' + e.message }, 500, corsOrigin);
    }
  }
};

function jsonResponse(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': origin,
    }
  });
}
