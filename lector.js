/**
 * lector.js — "Modo lectura": el servidor descarga una página y devuelve su TEXTO e imágenes limpios,
 * para que tu app los muestre con TU diseño, sin iframe (que muchos sitios bloquean).
 *
 * SEGURIDAD (esto NO es un proxy abierto):
 *  1. Solo se abren enlaces FIRMADOS por tu servidor: los que él mismo puso en los resultados de búsqueda
 *     (campo "leer_api"). Con una URL inventada, la firma no coincide y se rechaza (403).
 *  2. Protección contra SSRF: solo http/https en los puertos 80 y 443, sin usuario/contraseña, sin direcciones IP
 *     sueltas, y se bloquean las direcciones privadas, locales y de metadatos de nube (127.x, 10.x, 192.168.x,
 *     169.254.x, ::1…). La comprobación se hace al conectar (no solo antes), y también en cada redirección.
 *  3. Límites: 10 s, 2 MB, máx. 3 redirecciones, solo páginas HTML. No se envían cookies ni se ejecuta JavaScript.
 *  4. En modo seguro (BUSQUEDA_SEGURA) se bloquean páginas cuyo título o dominio tengan palabras prohibidas.
 *
 * No se guardan páginas: solo una copia en memoria de 10 minutos.
 * El contenido pertenece a sus autores (a diferencia de Wikipedia, no tiene licencia abierta): es una vista
 * temporal para el usuario, con el crédito y el enlace a la página original. Los enlaces dentro del texto se quitan.
 *
 * Variable recomendada en Render: LECTOR_SECRETO = una frase larga al azar (sin ella, los enlaces dejan de valer
 * cada vez que el servidor se reinicia).
 */
'use strict';

const crypto = require('node:crypto');
const dns = require('node:dns');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const zlib = require('node:zlib');

const LIM = { bytes: 2 * 1024 * 1024, ms: 10000, redirecciones: 3, bloques: 300, texto: 80000, imagenes: 12, vigenciaSeg: 6 * 3600 };
const SECRETO = process.env.LECTOR_SECRETO || crypto.randomBytes(32).toString('hex');
if (!process.env.LECTOR_SECRETO) console.log('[lector] LECTOR_SECRETO no está puesto: los enlaces de lectura dejarán de valer al reiniciar el servidor');

// ───────────────────────── Enlaces firmados ─────────────────────────
const hmac = (url, e) => crypto.createHmac('sha256', SECRETO).update(url + '|' + e).digest('hex').slice(0, 32);
function enlaceLector(url) {
  const e = Math.floor(Date.now() / 1000) + LIM.vigenciaSeg;
  return '/api/leer?u=' + encodeURIComponent(url) + '&e=' + e + '&f=' + hmac(url, e);
}
function verificarFirma(url, e, f) {
  if (typeof url !== 'string' || typeof f !== 'string' || !/^\d{9,12}$/.test(String(e))) return false;
  if (Number(e) < Math.floor(Date.now() / 1000)) return false; // vencido
  const esperado = Buffer.from(hmac(url, e)), recibido = Buffer.from(f);
  return esperado.length === recibido.length && crypto.timingSafeEqual(esperado, recibido);
}
// Añade "leer_api" a los resultados de búsqueda (menos Wikipedia, que ya trae articulo_api)
function agregarEnlacesLectura(resultados) {
  return (resultados || []).map((r) => {
    if (!r || r.articulo_api || typeof r.url !== 'string' || !/^https?:\/\//i.test(r.url)) return r;
    return Object.assign({}, r, { leer_api: enlaceLector(r.url) });
  });
}

// ───────────────────────── Protección contra SSRF ─────────────────────────
function ipEsPrivada(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168)) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const x = ip.toLowerCase();
    if (x === '::' || x === '::1') return true;
    if (x.startsWith('::ffff:')) { const v4 = x.slice(7); return net.isIPv4(v4) ? ipEsPrivada(v4) : true; } // IPv4 camuflada en IPv6
    return /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || x.startsWith('ff') || x.startsWith('2002:') || x.startsWith('2001:0:') || x.startsWith('2001:db8') || x.startsWith('64:ff9b');
  }
  return true; // si no sabemos qué es, no
}
function validarUrl(texto, permitirPrivadas) {
  let u;
  try { u = new URL(texto); } catch (_) { return { ok: false, motivo: 'Dirección no válida' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, motivo: 'Solo se permiten páginas http y https' };
  if (permitirPrivadas) return { ok: true, url: u };            // SOLO para pruebas: la ruta pública nunca lo activa
  if (u.username || u.password) return { ok: false, motivo: 'No se permiten direcciones con usuario o contraseña' };
  if (u.port && u.port !== '80' && u.port !== '443') return { ok: false, motivo: 'Puerto no permitido' };
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (net.isIP(host)) return { ok: false, motivo: 'No se permiten direcciones IP; usa el nombre del sitio' };
  if (!host.includes('.') || host === 'localhost' || /\.(local|localhost|internal|lan|home|corp|intranet)$/.test(host)) return { ok: false, motivo: 'Destino no permitido' };
  return { ok: true, url: u };
}
// Se ejecuta AL CONECTAR: aunque un nombre cambie de dirección a mitad de camino, no se llega a una IP privada
function lookupSeguro(hostname, options, cb) {
  dns.lookup(hostname, { all: true, verbatim: true }, (err, addrs) => {
    if (err) return cb(err);
    if (!addrs.length || addrs.some((a) => ipEsPrivada(a.address))) return cb(new Error('Destino no permitido'));
    if (options && options.all) return cb(null, addrs);
    cb(null, addrs[0].address, addrs[0].family);
  });
}

// ───────────────────────── Descarga con límites ─────────────────────────
function descargar(urlTexto, opc, saltos) {
  const o = Object.assign({ permitirPrivadas: false, maxBytes: LIM.bytes, timeoutMs: LIM.ms }, opc || {});
  saltos = saltos || 0;
  return new Promise((resolve, reject) => {
    const v = validarUrl(urlTexto, o.permitirPrivadas);
    if (!v.ok) return reject(new Error(v.motivo));
    const u = v.url;
    const modulo = u.protocol === 'https:' ? https : http;
    let listo = false;
    const fin = (err, res) => { if (listo) return; listo = true; clearTimeout(timer); err ? reject(err) : resolve(res); };
    const req = modulo.request(u, {
      method: 'GET', lookup: o.permitirPrivadas ? undefined : lookupSeguro, agent: false,
      headers: { 'User-Agent': 'CodeIDE-Lector/1.0 (modo lectura para un usuario)', Accept: 'text/html,application/xhtml+xml;q=0.9', 'Accept-Language': 'es,en;q=0.8', 'Accept-Encoding': 'gzip, deflate, br' },
    }, (res) => {
      const s = res.statusCode;
      if ([301, 302, 303, 307, 308].includes(s) && res.headers.location) {
        res.resume();
        if (saltos >= LIM.redirecciones) return fin(new Error('Demasiadas redirecciones'));
        let siguiente;
        try { siguiente = new URL(res.headers.location, u).toString(); } catch (_) { return fin(new Error('Redirección no válida')); }
        return descargar(siguiente, opc, saltos + 1).then((r) => fin(null, r), (e) => fin(e));  // cada salto se vuelve a validar
      }
      if (s < 200 || s >= 300) { res.resume(); return fin(new Error('La página respondió con error ' + s)); }
      const tipo = String(res.headers['content-type'] || '').toLowerCase();
      if (!/^(text\/html|application\/xhtml\+xml)/.test(tipo)) { res.resume(); return fin(new Error('Este contenido no es una página: no se puede mostrar en modo lectura')); }
      const enc = String(res.headers['content-encoding'] || '').toLowerCase();
      let flujo = res;
      if (enc === 'gzip') flujo = res.pipe(zlib.createGunzip());
      else if (enc === 'deflate') flujo = res.pipe(zlib.createInflate());
      else if (enc === 'br') flujo = res.pipe(zlib.createBrotliDecompress());
      else if (enc && enc !== 'identity') { res.resume(); return fin(new Error('Compresión no soportada')); }
      const trozos = []; let total = 0;
      flujo.on('data', (d) => { total += d.length; if (total > o.maxBytes) { req.destroy(); flujo.destroy(); return fin(new Error('La página es demasiado grande')); } trozos.push(d); });
      flujo.on('end', () => fin(null, { url: u.toString(), tipo, cuerpo: Buffer.concat(trozos) }));
      flujo.on('error', (e) => fin(new Error('No se pudo leer la página: ' + e.message)));
    });
    const timer = setTimeout(() => { req.destroy(); fin(new Error('La página tardó demasiado en responder')); }, o.timeoutMs);
    req.on('error', (e) => fin(new Error(e.message === 'Destino no permitido' ? 'Destino no permitido' : 'No se pudo abrir la página: ' + e.message)));
    req.end();
  });
}

// ───────────────────────── Extracción del contenido ─────────────────────────
const ENTIDADES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', laquo: '«', raquo: '»', copy: '©', reg: '®', bull: '•', middot: '·',
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ', Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', Ntilde: 'Ñ', uuml: 'ü', iexcl: '¡', iquest: '¿', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’' };
const decodificar = (t) => String(t).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e) => {
  if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ''; }
  return Object.prototype.hasOwnProperty.call(ENTIDADES, e) ? ENTIDADES[e] : m;
});
const limpiar = (h) => decodificar(String(h).replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const atributo = (tag, nombre) => { const m = tag.match(new RegExp('\\b' + nombre + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i')); return m ? decodificar(m[1] || m[2] || m[3] || '') : ''; };
function decodificarCuerpo(buf, tipo) {
  let cs = (String(tipo).match(/charset=["']?([\w-]+)/i) || [])[1];
  if (!cs) cs = (buf.subarray(0, 4096).toString('latin1').match(/<meta[^>]+charset=["']?([\w-]+)/i) || [])[1];
  try { return new TextDecoder(cs || 'utf-8').decode(buf); } catch (_) { return buf.toString('utf8'); }
}
function extraerContenido(html, base) {
  const meta = (n) => { const m = html.match(new RegExp('<meta[^>]+(?:property|name)=["\']' + n + '["\'][^>]*>', 'i')); return m ? atributo(m[0], 'content') : ''; };
  const titulo = limpiar(meta('og:title') || (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
  const descripcion = limpiar(meta('og:description') || meta('description')).slice(0, 300);
  const sitio = limpiar(meta('og:site_name')) || (() => { try { return new URL(base).hostname.replace(/^www\./, ''); } catch (_) { return ''; } })();

  let limpio = html.replace(/<!--[\s\S]*?-->/g, '');
  for (const t of ['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'form', 'nav', 'header', 'footer', 'aside', 'button', 'select', 'dialog', 'head']) {
    limpio = limpio.replace(new RegExp('<' + t + '\\b[\\s\\S]*?<\\/' + t + '\\s*>', 'gi'), ' ');
  }
  // Zona principal: el <article> con más texto; si no hay, <main>; si no, todo el <body>
  let raiz = limpio;
  const arts = [...limpio.matchAll(/<article\b[\s\S]*?<\/article\s*>/gi)].map((m) => m[0]).sort((a, b) => limpiar(b).length - limpiar(a).length);
  const principal = (limpio.match(/<main\b[\s\S]*?<\/main\s*>/i) || [])[0];
  if (arts.length && limpiar(arts[0]).length > 300) raiz = arts[0]; else if (principal && limpiar(principal).length > 300) raiz = principal;

  const bloques = []; let lista = null, caracteres = 0, imagenes = 0, parrafosTexto = 0, ultimo = '';
  const cerrarLista = () => { if (lista && lista.items.length) bloques.push(lista); lista = null; };
  const re = /<(h[1-4]|p|li|blockquote|pre|figcaption)\b[^>]*>([\s\S]*?)<\/\1\s*>|<img\b[^>]*>/gi;
  let m;
  while ((m = re.exec(raiz)) !== null && bloques.length < LIM.bloques && caracteres < LIM.texto) {
    if (!m[1]) { // imagen
      cerrarLista();
      const tag = m[0]; const src = atributo(tag, 'src') || atributo(tag, 'data-src');
      if (!src || /^data:/i.test(src) || imagenes >= LIM.imagenes) continue;
      if (/(logo|icon|avatar|sprite|pixel|tracking|badge|spacer)/i.test(src + ' ' + atributo(tag, 'class'))) continue;
      const w = parseInt(atributo(tag, 'width'), 10), h = parseInt(atributo(tag, 'height'), 10);
      if ((w && w < 80) || (h && h < 80)) continue;
      let abs; try { abs = new URL(src, base); } catch (_) { continue; }
      if (abs.protocol !== 'https:' && abs.protocol !== 'http:') continue;
      imagenes++; bloques.push({ tipo: 'imagen', src: abs.toString(), alt: limpiar(atributo(tag, 'alt')).slice(0, 200) });
      continue;
    }
    const etiqueta = m[1].toLowerCase();
    const crudo = m[2];
    const texto = etiqueta === 'pre' ? decodificar(crudo.replace(/<[^>]+>/g, '')).replace(/\r/g, '').trim().slice(0, 4000) : limpiar(crudo);
    if (!texto || texto === ultimo) continue;
    if (etiqueta === 'li') {
      if (texto.length < 3) continue;
      if (!lista) lista = { tipo: 'lista', items: [] };
      lista.items.push(texto.slice(0, 500)); caracteres += texto.length; ultimo = texto; continue;
    }
    cerrarLista();
    if (/^h[1-4]$/.test(etiqueta)) { if (texto.length < 2) continue; bloques.push({ tipo: 'titulo', nivel: Number(etiqueta[1]), texto: texto.slice(0, 200) }); }
    else if (etiqueta === 'pre') bloques.push({ tipo: 'codigo', texto });
    else if (etiqueta === 'figcaption') { if (texto.length < 10) continue; bloques.push({ tipo: 'pie', texto: texto.slice(0, 300) }); }
    else { if (texto.length < 25) continue; bloques.push({ tipo: etiqueta === 'blockquote' ? 'cita' : 'parrafo', texto: texto.slice(0, 2000) }); parrafosTexto += texto.length; }
    caracteres += texto.length; ultimo = texto;
  }
  cerrarLista();
  return { titulo, descripcion, sitio, bloques, textoUtil: parrafosTexto };
}

// ───────────────────────── Leer una página ─────────────────────────
let _seg; // ayudantes de búsqueda segura (se cargan al usarlos para no crear dependencias circulares)
function seguridad() {
  if (_seg === undefined) { try { const b = require('./buscar-web'); _seg = { activa: b.busquedaSegura, bloqueado: b.terminoBloqueado }; } catch (_) { _seg = null; } }
  return _seg;
}
const cache = new Map();
async function leerPagina(urlTexto, opc) {
  const o = opc || {};
  const v = validarUrl(urlTexto, o.permitirPrivadas);
  if (!v.ok) return { exito: false, error: v.motivo };
  const clave = v.url.toString();
  const c = cache.get(clave);
  if (c && Date.now() - c.t < 10 * 60 * 1000) return Object.assign({}, c.r, { deCache: true });
  let d;
  try { d = await descargar(clave, o); } catch (e) { return { exito: false, error: e.message, url_original: clave }; }
  const html = decodificarCuerpo(d.cuerpo, d.tipo);
  const c2 = extraerContenido(html, d.url);
  const seg = seguridad();
  if (seg && seg.activa() && seg.bloqueado(c2.titulo + ' ' + new URL(d.url).hostname.replace(/[.-]/g, ' '))) {
    return { exito: true, bloques: [], modo_seguro: true, aviso: 'Esta página no está permitida en el modo seguro.' };
  }
  if (c2.textoUtil < 200) {
    return { exito: false, error: 'Esta página no tiene texto que se pueda mostrar aquí (puede necesitar JavaScript). Ábrela en el navegador del teléfono.', url_original: d.url };
  }
  const dominio = new URL(d.url).hostname.replace(/^www\./, '');
  const r = {
    exito: true, titulo: c2.titulo || dominio, descripcion: c2.descripcion, sitio: c2.sitio, dominio, bloques: c2.bloques,
    url_original: d.url,
    atribucion: 'Contenido de ' + dominio + ' · mostrado en modo lectura',
    aviso_derechos: 'El contenido pertenece a su autor. Para verlo completo, abre la página original.',
    imagenes_externas: c2.bloques.some((b) => b.tipo === 'imagen'),
  };
  if (cache.size > 100) cache.clear();
  cache.set(clave, { t: Date.now(), r });
  return r;
}

// ───────────────────────── Ruta ─────────────────────────
function attachLector(app, { rateLimit }) {
  const limitar = rateLimit({ windowMs: 10 * 60 * 1000, max: 40, standardHeaders: true, legacyHeaders: false, message: { exito: false, error: 'Demasiadas lecturas, espera unos minutos' } });
  app.get('/api/leer', limitar, async (req, res) => {
    const { u, e, f } = req.query;
    if (!verificarFirma(u, e, f)) return res.status(403).json({ exito: false, error: 'Enlace no válido o vencido. Vuelve a hacer la búsqueda.' });
    res.json(await leerPagina(u));
  });
}

module.exports = { attachLector, agregarEnlacesLectura, enlaceLector, verificarFirma, leerPagina, extraerContenido, validarUrl, ipEsPrivada, descargar, lookupSeguro, LIM };
