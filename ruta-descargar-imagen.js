// Pega esto en el index.js / server.js de tu servidor en Render (Express), junto a tus otras rutas /api/...
// Requiere Node 18+ (fetch incluido). Si usas "cors()", déjalo como está.
app.get('/api/descargar-imagen', async (req, res) => {
  try {
    const url = String(req.query.url || '');
    if (!/^https?:\/\//i.test(url)) return res.status(400).json({ exito: false, error: 'url inválida' });
    const nombre = String(req.query.nombre || 'imagen').replace(/[^a-z0-9_-]/gi, '_').slice(0, 40) || 'imagen';
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': new URL(url).origin } });
    if (!r.ok) return res.status(502).json({ exito: false, error: 'origen respondió ' + r.status });
    const tipo = r.headers.get('content-type') || 'image/jpeg';
    if (!tipo.startsWith('image/')) return res.status(415).json({ exito: false, error: 'no es una imagen' });
    const ext = tipo.split('/')[1].split(';')[0].replace('svg+xml', 'svg').replace('jpeg', 'jpg');
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 25 * 1024 * 1024) return res.status(413).json({ exito: false, error: 'imagen muy grande' });
    res.set({
      'Content-Type': tipo,
      'Content-Disposition': 'attachment; filename="' + nombre + '.' + ext + '"',
      'Access-Control-Allow-Origin': '*'
    });
    res.send(buf);
  } catch (e) {
    res.status(500).json({ exito: false, error: String(e.message || e) });
  }
});
