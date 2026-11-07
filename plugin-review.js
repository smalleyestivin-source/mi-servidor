/**
 * plugin-review.js — Revisión de seguridad de plugins (ZIP / .vsix) antes de publicarlos.
 *
 * Qué hace, en este orden (sin extraer ni ejecutar NADA del archivo):
 *  1. Inspecciona el ZIP leyendo solo su directorio central: rutas peligrosas (zip-slip), enlaces simbólicos,
 *     archivos cifrados, bombas ZIP (tamaño, proporción y archivos superpuestos), duplicados, datos extra al final.
 *  2. Si configuras CLAMAV_HOST, manda el archivo a ClamAV (protocolo INSTREAM) para buscar virus conocidos.
 *
 * El resultado NUNCA es "aprobado": lo mejor que puede salir es "revision_pendiente".
 * Un ZIP limpio no prueba que el código del plugin sea seguro, y ClamAV solo detecta amenazas ya conocidas.
 *
 * Variables (todas opcionales): CLAMAV_HOST, CLAMAV_PORT (3310), CLAMAV_TIMEOUT_MS (90000), PLUGIN_MAX_BYTES (20 MB).
 * Si CLAMAV_HOST está puesto pero ClamAV no responde, el resultado es "error_analisis" (no se deja pasar).
 */
'use strict';

const fsp = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const LIM = {
  bytes: Number(process.env.PLUGIN_MAX_BYTES) || 20 * 1024 * 1024,
  entradas: 2000,
  totalDescomprimido: 150 * 1024 * 1024,
  porArchivo: 50 * 1024 * 1024,
  ratio: 100,                    // descomprimido / comprimido (solo se exige en archivos de más de 1 MB)
  directorioCentral: 4 * 1024 * 1024,
};
const EXT_SOSPECHOSAS = new Set(['.exe', '.dll', '.so', '.dylib', '.bat', '.cmd', '.com', '.scr', '.msi', '.apk', '.jar', '.vbs', '.ps1', '.sh']);
const rechazo = (motivo) => ({ ok: false, motivo });

// ───────────────────────── 1) Inspección del ZIP ─────────────────────────
async function inspeccionarZip(filePath) {
  const st = await fsp.stat(filePath);
  if (st.size < 22) return rechazo('El archivo es demasiado pequeño para ser un ZIP');
  const fh = await fsp.open(filePath, 'r');
  try {
    // Registro final (EOCD): está en los últimos 22 bytes + el comentario (máx. 65535)
    const tailLen = Math.min(st.size, 22 + 65535);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, st.size - tailLen);
    let e = -1;
    for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { e = i; break; }
    if (e < 0) return rechazo('No es un ZIP válido (no se encontró su directorio central)');

    const total = tail.readUInt16LE(e + 10);
    const cdSize = tail.readUInt32LE(e + 12);
    const cdOff = tail.readUInt32LE(e + 16);
    const comentario = tail.readUInt16LE(e + 20);
    if (total === 0xFFFF || cdSize === 0xFFFFFFFF || cdOff === 0xFFFFFFFF) return rechazo('ZIP64 no soportado: no se puede revisar con seguridad');
    if (e + 22 + comentario !== tailLen) return rechazo('El ZIP tiene datos extra al final (puede ser un archivo disfrazado)');
    if (total === 0) return rechazo('El ZIP está vacío');
    if (total > LIM.entradas) return rechazo(`Demasiados archivos dentro del ZIP (${total}; máximo ${LIM.entradas})`);
    if (cdSize > LIM.directorioCentral || cdOff + cdSize > st.size) return rechazo('Directorio central del ZIP inválido');

    const cd = Buffer.alloc(cdSize);
    await fh.read(cd, 0, cdSize, cdOff);

    let p = 0, descomprimido = 0, archivos = 0;
    const nombres = new Set(), tramos = [], advertencias = [];
    for (let n = 0; n < total; n++) {
      if (p + 46 > cdSize || cd.readUInt32LE(p) !== 0x02014b50) return rechazo('El directorio central del ZIP está dañado');
      const hechoEn = cd.readUInt16LE(p + 4);
      const banderas = cd.readUInt16LE(p + 8);
      const metodo = cd.readUInt16LE(p + 10);
      const comp = cd.readUInt32LE(p + 20);
      const unc = cd.readUInt32LE(p + 24);
      const lenNombre = cd.readUInt16LE(p + 28), lenExtra = cd.readUInt16LE(p + 30), lenCom = cd.readUInt16LE(p + 32);
      const atributos = cd.readUInt32LE(p + 38);
      const offLocal = cd.readUInt32LE(p + 42);
      if (p + 46 + lenNombre + lenExtra + lenCom > cdSize) return rechazo('El directorio central del ZIP está dañado');

      const crudo = cd.subarray(p + 46, p + 46 + lenNombre);
      const nombre = crudo.toString((banderas & 0x800) ? 'utf8' : 'latin1');
      p += 46 + lenNombre + lenExtra + lenCom;

      if (banderas & 1) return rechazo('El ZIP tiene archivos cifrados (con contraseña): no se pueden revisar');
      if (comp === 0xFFFFFFFF || unc === 0xFFFFFFFF) return rechazo('ZIP64 no soportado: no se puede revisar con seguridad');
      if (nombre.includes('\0')) return rechazo('Nombre de archivo inválido dentro del ZIP');

      const ruta = nombre.replace(/\\/g, '/');
      if (ruta.startsWith('/') || /^[A-Za-z]:/.test(ruta) || ruta.split('/').includes('..')) {
        return rechazo('Ruta peligrosa dentro del ZIP: ' + nombre.slice(0, 80));
      }
      if ((hechoEn >> 8) === 3 && ((atributos >>> 16) & 0o170000) === 0o120000) {
        return rechazo('El ZIP contiene enlaces simbólicos: ' + nombre.slice(0, 80));
      }
      const clave = ruta.toLowerCase();
      if (nombres.has(clave)) return rechazo('El ZIP tiene archivos duplicados: ' + nombre.slice(0, 80));
      nombres.add(clave);

      if (unc > LIM.porArchivo) return rechazo(`Un archivo del ZIP es demasiado grande al descomprimirse: ${nombre.slice(0, 60)}`);
      if (unc > 1024 * 1024 && (comp === 0 || unc / comp > LIM.ratio)) return rechazo('El ZIP parece una bomba de compresión: ' + nombre.slice(0, 60));
      descomprimido += unc;
      if (descomprimido > LIM.totalDescomprimido) return rechazo('El ZIP ocuparía demasiado al descomprimirse');

      // El dato del archivo debe caber antes del directorio central, sin pisar a otro (bombas con archivos superpuestos)
      const fin = offLocal + 30 + lenNombre + comp;
      if (fin > cdOff) return rechazo('El ZIP tiene un archivo fuera de lugar');
      tramos.push([offLocal, fin]);

      if (!ruta.endsWith('/')) {
        archivos++;
        const ext = path.extname(ruta).toLowerCase();
        if (EXT_SOSPECHOSAS.has(ext) && advertencias.length < 20) advertencias.push('Contiene un archivo ejecutable o binario: ' + nombre.slice(0, 80));
        if ((ext === '.zip' || ext === '.vsix') && advertencias.length < 20) advertencias.push('Contiene un ZIP dentro de otro (no se revisa por dentro aquí): ' + nombre.slice(0, 80));
        if (metodo !== 0 && metodo !== 8 && advertencias.length < 20) advertencias.push('Usa un método de compresión poco común: ' + nombre.slice(0, 80));
      }
    }
    tramos.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < tramos.length; i++) {
      if (tramos[i][0] < tramos[i - 1][1]) return rechazo('El ZIP tiene archivos superpuestos (posible bomba ZIP)');
    }
    return { ok: true, archivos, descomprimido, advertencias };
  } finally {
    await fh.close();
  }
}

// ───────────────────────── 2) ClamAV (protocolo INSTREAM) ─────────────────────────
function configClam() {
  const host = process.env.CLAMAV_HOST;
  if (!host) return null;
  return { host, port: Number(process.env.CLAMAV_PORT) || 3310, timeoutMs: Number(process.env.CLAMAV_TIMEOUT_MS) || 90000 };
}
const escribir = (socket, buf) => new Promise((ok, mal) => socket.write(buf, (err) => (err ? mal(err) : ok())));

function escanearConClamAV(filePath, cfg) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: cfg.host, port: cfg.port });
    let respuesta = '', listo = false;
    const timer = setTimeout(() => fin(new Error('Tiempo de análisis agotado')), cfg.timeoutMs);
    function fin(err, res) {
      if (listo) return;
      listo = true; clearTimeout(timer); socket.destroy();
      err ? reject(err) : resolve(res);
    }
    socket.on('error', (e) => fin(new Error('No se pudo conectar con ClamAV: ' + e.message)));
    socket.on('close', () => fin(new Error('ClamAV cerró la conexión sin responder')));
    socket.on('data', (d) => {
      respuesta += d.toString('utf8');
      if (respuesta.length > 4096) return fin(new Error('Respuesta inesperada de ClamAV'));
      if (respuesta.includes('\0') || respuesta.includes('\n')) {
        const m = respuesta.replace(/\0/g, '').trim();
        if (/ FOUND$/.test(m)) fin(null, { estado: 'infectado', mensaje: m });
        else if (/ OK$/.test(m)) fin(null, { estado: 'limpio', mensaje: m });
        else fin(new Error('Respuesta de ClamAV: ' + m.slice(0, 120)));
      }
    });
    socket.once('connect', async () => {
      let fh;
      try {
        await escribir(socket, Buffer.from('zINSTREAM\0'));
        fh = await fsp.open(filePath, 'r');
        const buf = Buffer.alloc(64 * 1024);
        let pos = 0, enviados = 0;
        for (;;) {
          const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
          if (!bytesRead) break;
          pos += bytesRead; enviados += bytesRead;
          if (enviados > LIM.bytes) throw new Error('El archivo supera el límite permitido');
          const largo = Buffer.alloc(4); largo.writeUInt32BE(bytesRead, 0);
          await escribir(socket, largo);
          await escribir(socket, Buffer.from(buf.subarray(0, bytesRead)));
        }
        await escribir(socket, Buffer.alloc(4)); // fin del archivo
      } catch (e) {
        fin(e);
      } finally {
        if (fh) await fh.close().catch(() => {});
      }
    });
  });
}

function pingClamAV(cfg) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: cfg.host, port: cfg.port });
    let r = '';
    const t = setTimeout(() => { socket.destroy(); resolve(false); }, 5000);
    socket.on('error', () => { clearTimeout(t); resolve(false); });
    socket.on('data', (d) => { r += d.toString(); if (r.includes('PONG')) { clearTimeout(t); socket.destroy(); resolve(true); } });
    socket.once('connect', () => socket.write('zPING\0'));
  });
}

// ───────────────────────── Revisión completa de un archivo ─────────────────────────
async function revisarPlugin(filePath) {
  const zip = await inspeccionarZip(filePath);
  if (!zip.ok) return { estado: 'rechazado', http: 400, motivos: [zip.motivo] };

  let antivirus = 'no_configurado';
  const cfg = configClam();
  if (cfg) {
    try {
      const r = await escanearConClamAV(filePath, cfg);
      if (r.estado === 'infectado') return { estado: 'infectado', http: 422, motivos: ['El antivirus detectó contenido sospechoso: ' + r.mensaje] };
      antivirus = 'limpio';
    } catch (e) {
      console.error('[plugin-review] ClamAV falló: ' + e.message);
      return { estado: 'error_analisis', http: 503, motivos: ['No se pudo completar el análisis antivirus. El plugin no se debe publicar todavía.'] };
    }
  }
  return {
    estado: 'revision_pendiente', http: 200, antivirus,
    archivos: zip.archivos, advertencias: zip.advertencias,
    nota: 'Esto NO aprueba el plugin. Un ZIP limpio no garantiza que su código sea seguro: falta la revisión del contenido.',
  };
}

// ───────────────────────── Rutas ─────────────────────────
function attachPluginReview(app, { verificarAppKey, rateLimit, multer }) {
  const limitar = rateLimit({
    windowMs: 10 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false,
    message: { exito: false, error: 'Demasiadas revisiones, espera unos minutos' },
  });
  const upload = multer({
    dest: path.join(os.tmpdir(), 'codeide-plugin-review'),
    limits: { fileSize: LIM.bytes, files: 1 },
    fileFilter(_req, file, cb) {
      const ext = path.extname(file.originalname || '').toLowerCase();
      if (ext !== '.zip' && ext !== '.vsix') return cb(new Error('El plugin debe enviarse como .zip o .vsix'));
      cb(null, true);
    },
  });

  app.post('/api/plugins/revisar', verificarAppKey, limitar, (req, res) => {
    upload.single('package')(req, res, async (err) => {
      if (err) {
        const tamano = err.code === 'LIMIT_FILE_SIZE';
        return res.status(tamano ? 413 : 400).json({ estado: 'rechazado', error: tamano ? 'El archivo supera el tamaño máximo' : err.message });
      }
      if (!req.file) return res.status(400).json({ estado: 'rechazado', error: 'Adjunta el archivo en el campo "package"' });
      try {
        const r = await revisarPlugin(req.file.path);
        const { http, ...cuerpo } = r;
        res.status(http).json(cuerpo);
      } catch (e) {
        console.error('[plugin-review] error:', e.message);
        res.status(500).json({ estado: 'error_analisis', error: 'No se pudo revisar el archivo' });
      } finally {
        fsp.unlink(req.file.path).catch(() => {});
      }
    });
  });

  // ¿Está configurado y respondiendo el antivirus?
  app.get('/api/plugins/antivirus', async (_req, res) => {
    const cfg = configClam();
    if (!cfg) return res.json({ configurado: false, disponible: false });
    res.json({ configurado: true, disponible: await pingClamAV(cfg) });
  });
}

module.exports = { attachPluginReview, revisarPlugin, inspeccionarZip, escanearConClamAV, pingClamAV, LIM };
