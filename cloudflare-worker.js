/**
 * cloudflare-worker.js — Worker de CodeIDE: busca plugins (Open VSX + GitHub + npm) y ayuda a tu servidor de Render.
 *
 * NO cambia nada en Render. Es una dirección NUEVA (…workers.dev); tu CodeIDE sigue usando
 * https://mi-servidor-v2.onrender.com hasta que tú decidas cambiarlo.
 *
 * Qué hace:
 *  1. Cron cada 5 min: visita /health de Render para despertarlo (aunque esté dormido).
 *  2. /status: dice en 4 s si Render está activo o despertando.
 *  3. /api/autocompletado: lo guarda en la caché de Cloudflare (1 día) y lo sirve al instante.
 *  4. Peticiones GET normales: si Render no responde en 10 s (está despertando) contesta un
 *     aviso claro (503 + Retry-After) en vez de dejar al usuario esperando, y lo despierta.
 *  5. POST, WebSockets (PeerJS, /ide-bridge) y demás: pasan directo a Render, sin tocarlos.
 *  6. POST /api/marketplace-search: busca plugins en Open VSX, GitHub y npm a la vez, en el formato que espera CodeIDE.
 *     Secreto opcional GITHUB_TOKEN (sin permisos especiales) para que GitHub no limite las búsquedas.
 *
 * Variables opcionales (Settings → Variables): ORIGEN = URL de tu servidor en Render.
 */
const ORIGEN_DEFECTO = 'https://mi-servidor-v2.onrender.com';
const CACHEABLES = new Set(['/api/autocompletado']);
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-app-key, x-api-key',
  'Access-Control-Max-Age': '86400',
};

const origenDe = (env) => String((env && env.ORIGEN) || ORIGEN_DEFECTO).replace(/\/+$/, '');
const json = (status, obj, extra) =>
  new Response(JSON.stringify(obj), { status, headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, CORS, extra || {}) });

async function conTimeout(url, init, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, Object.assign({}, init, { signal: ctrl.signal }));
  } finally {
    clearTimeout(timer);
  }
}

// Visita /health: sirve para despertar a Render. Nunca lanza error.
async function despertar(origen, ms) {
  try {
    const r = await conTimeout(origen + '/health', { headers: { 'User-Agent': 'ayudante-render' } }, ms || 30000);
    return r.ok;
  } catch (_) {
    return false;
  }
}

async function estado(origen, ctx) {
  const t0 = Date.now();
  try {
    const r = await conTimeout(origen + '/health', {}, 4000);
    return json(200, { render: r.ok ? 'activo' : 'con_error', http: r.status, ms: Date.now() - t0 }, { 'Cache-Control': 'no-store' });
  } catch (_) {
    if (ctx && ctx.waitUntil) ctx.waitUntil(despertar(origen)); // aprovecha para despertarlo
    return json(200, { render: 'despertando_o_caido', ms: Date.now() - t0, nota: 'Reintenta en ~30 s' }, { 'Cache-Control': 'no-store' });
  }
}


// ── Buscador de plugins: Open VSX (instalables) + GitHub + npm, en el formato que lee CodeIDE ──
const MS_HOST = /(^|\.)(visualstudio\.com|vsassets\.io|vo\.msecnd\.net)$/i;
const esMs = (u) => { try { return MS_HOST.test(new URL(String(u || '')).hostname); } catch (_) { return false; } };
async function jsonDe(url, init, ms) {
  const r = await conTimeout(url, init || {}, ms || 8000);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
async function buscarPlugins(query, n, env) {
  const q = encodeURIComponent(query);
  const ghHeaders = { 'User-Agent': 'CodeIDE', Accept: 'application/vnd.github+json' };
  if (env && env.GITHUB_TOKEN) ghHeaders.Authorization = 'Bearer ' + env.GITHUB_TOKEN;
  const [ov, gh, np] = await Promise.allSettled([
    jsonDe('https://open-vsx.org/api/-/search?query=' + q + '&size=' + n),
    jsonDe('https://api.github.com/search/repositories?sort=stars&per_page=10&q=' + q + '+topic:vscode-extension', { headers: ghHeaders }),
    jsonDe('https://registry.npmjs.org/-/v1/search?size=10&text=' + q + '+keywords:vscode-extension'),
  ]);
  const out = [];
  if (ov.status === 'fulfilled') for (const e of (ov.value.extensions || [])) {
    const f = e.files || {};
    if (esMs(f.download) || esMs(f.icon)) continue;
    out.push({ uniqueId: 'openvsx-' + (e.namespace || 'x') + '.' + e.name, name: e.displayName || e.name, description: e.description || '',
      publisher: e.namespace || '', version: e.version || '', icon: f.icon || '', downloads: e.downloadCount || 0,
      source: 'openvsx', vsixUrl: f.download || null });
  }
  if (gh.status === 'fulfilled') for (const r of (gh.value.items || [])) {   // si GitHub limita (403), simplemente no hay "items"
    out.push({ uniqueId: 'github-' + r.full_name, name: r.name, description: r.description || '', publisher: (r.owner && r.owner.login) || '',
      version: '', icon: (r.owner && r.owner.avatar_url) || '', downloads: r.stargazers_count || 0, source: 'github',
      cloneUrl: r.clone_url, repoUrl: r.html_url, tags: (r.topics || []).join(',') });
  }
  if (np.status === 'fulfilled') for (const o of (np.value.objects || [])) {
    const p = o.package || {}; const l = p.links || {};
    out.push({ uniqueId: 'npm-' + p.name, name: p.name, description: p.description || '', publisher: (p.publisher && p.publisher.username) || 'npm',
      version: p.version || '', icon: '', downloads: 0, source: 'npm', npmUrl: l.npm || ('https://www.npmjs.com/package/' + p.name),
      repoUrl: l.repository || l.homepage || '', tags: (p.keywords || []).join(',') });
  }
  const errores = [['Open VSX', ov], ['GitHub', gh], ['npm', np]].filter(([, x]) => x.status === 'rejected').map(([n2, x]) => n2 + ': ' + (x.reason && x.reason.message));
  return { out, errores };
}
async function manejarMarketplace(request, env, ctx) {
  let body = {};
  try { body = await request.json(); } catch (_) {}
  const query = String(body.query || '').slice(0, 100);
  const n = Math.max(1, Math.min(50, parseInt(body.pageSize, 10) || 30));
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const key = new Request('https://cache.interno/plugins?n=' + n + '&q=' + encodeURIComponent(query.toLowerCase()));
  if (cache) { const hit = await cache.match(key); if (hit) return new Response(hit.body, hit); }
  const { out, errores } = await buscarPlugins(query, n, env);
  if (!out.length && errores.length === 3) return json(502, { exito: false, error: 'No se pudo buscar plugins: ' + errores.join(' · ') });
  const res = json(200, { exito: true, resultados: out, avisos: errores }, { 'Cache-Control': 'public, max-age=3600' });
  if (cache && out.length && ctx && ctx.waitUntil) ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

export default {
  async fetch(request, env, ctx) {
    const origen = origenDe(env);
    const url = new URL(request.url);
    const destino = origen + url.pathname + url.search;
    const ms = Number(env && env.TIMEOUT_GET_MS) || 10000;

    if (url.pathname === '/status') return estado(origen, ctx);

    // Preflight CORS: lo contesta el Worker (no despierta a Render)
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    // Plugins: se resuelve aquí, sin pasar por Render
    if (url.pathname === '/api/marketplace-search' && request.method === 'POST') return manejarMarketplace(request, env, ctx);

    // WebSockets (PeerJS, puente del IDE): directo a Render, sin tocarlos
    if ((request.headers.get('Upgrade') || '').toLowerCase() === 'websocket') {
      return fetch(new Request(destino, request));
    }

    // Archivos que casi no cambian: caché de Cloudflare (1 día)
    if (request.method === 'GET' && CACHEABLES.has(url.pathname)) {
      const cache = typeof caches !== 'undefined' ? caches.default : null;
      const key = new Request(origen + url.pathname, { method: 'GET' });
      if (cache) {
        const hit = await cache.match(key);
        if (hit) { const r = new Response(hit.body, hit); r.headers.set('X-Cache', 'HIT'); return r; }
      }
      try {
        const r = await conTimeout(destino, {}, 25000);
        if (!r.ok) return r;
        const copia = new Response(r.body, r);
        copia.headers.set('Cache-Control', 'public, max-age=86400');
        copia.headers.set('X-Cache', 'MISS');
        for (const [k, v] of Object.entries(CORS)) copia.headers.set(k, v);
        if (cache && ctx && ctx.waitUntil) ctx.waitUntil(cache.put(key, copia.clone()));
        return copia;
      } catch (_) {
        return json(503, { error: 'servidor_despertando', mensaje: 'El servidor está despertando. Reintenta en unos segundos.' }, { 'Retry-After': '15' });
      }
    }

    // GET normales: si Render no contesta rápido, avisar en vez de colgar
    if (request.method === 'GET' || request.method === 'HEAD') {
      try {
        return await conTimeout(destino, { method: request.method, headers: request.headers }, ms);
      } catch (_) {
        if (ctx && ctx.waitUntil) ctx.waitUntil(despertar(origen));
        return json(503, { error: 'servidor_despertando', mensaje: 'El servidor está despertando. Reintenta en unos segundos.' }, { 'Retry-After': '15' });
      }
    }

    // POST y demás: directo, sin límite corto (ejecutar código o IA puede tardar)
    return fetch(new Request(destino, request));
  },

  // Tarea programada (Cron Trigger): despierta a Render
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(despertar(origenDe(env), 30000));
  },
};
