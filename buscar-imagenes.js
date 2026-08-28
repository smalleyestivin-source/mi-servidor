// ==========================================================
// BÚSQUEDA DE IMÁGENES v2 — varios motores en paralelo + caché
// permanente en MongoDB (ya no se borra al reiniciar el servidor).
// ==========================================================
const { MongoClient } = require('mongodb');

// --- Configuración (variables de entorno, nunca aquí en texto) ---
// En Render → Environment:
//   MONGODB_URI=mongodb+srv://usuario:password@tu-cluster.mongodb.net/
//   GOOGLE_CSE_KEY_1, GOOGLE_CSE_KEY_2, GOOGLE_CSE_CX
//   UNSPLASH_ACCESS_KEY
//   PEXELS_API_KEY
//   PIXABAY_API_KEY
const MONGODB_URI = process.env.MONGODB_URI;
const GOOGLE_CSE_KEYS = [process.env.GOOGLE_CSE_KEY_1, process.env.GOOGLE_CSE_KEY_2].filter(Boolean);
const GOOGLE_CSE_CX = process.env.GOOGLE_CSE_CX;
const UNSPLASH_ACCESS_KEY = process.env.UNSPLASH_ACCESS_KEY;
const PEXELS_API_KEY = process.env.PEXELS_API_KEY;
const PIXABAY_API_KEY = process.env.PIXABAY_API_KEY; // pixabay.com/api/docs — gratis, con key simple

// --- Conexión a Mongo, reutilizada entre peticiones (no abre una nueva cada vez) ---
let clienteMongo = null;
async function coleccionCache() {
    if (!MONGODB_URI) return null; // si no configuraste Mongo, seguimos sin caché permanente
    if (!clienteMongo) {
        clienteMongo = new MongoClient(MONGODB_URI);
        await clienteMongo.connect();
    }
    return clienteMongo.db('mi_servidor').collection('cache_imagenes');
}

// --- Paso 1: revisar caché permanente ---
async function buscarEnCache(termino) {
    const col = await coleccionCache();
    if (!col) return null;
    return col.findOne({ termino: termino.toLowerCase() });
}

async function guardarEnCache(termino, resultados) {
    const col = await coleccionCache();
    if (!col) return; // sin Mongo configurado, simplemente no persiste (funciona igual, solo no recuerda)
    await col.updateOne(
        { termino: termino.toLowerCase() },
        { $set: { termino: termino.toLowerCase(), resultados, actualizado: new Date() } },
        { upsert: true }
    );
}

// --- Paso 2: cada motor, de forma independiente (uno no bloquea a otro) ---
async function buscarEnGoogle(termino) {
    for (const key of GOOGLE_CSE_KEYS) {
        try {
            const url = `https://www.googleapis.com/customsearch/v1?key=${key}&cx=${GOOGLE_CSE_CX}&q=${encodeURIComponent(termino)}&searchType=image&safe=active`;
            const res = await fetch(url);
            if (res.status === 429) continue; // esta key agotó cuota, prueba la siguiente
            if (!res.ok) continue;
            const data = await res.json();
            const urls = (data.items || []).map(i => ({ url: i.link, proveedor: 'google' }));
            if (urls.length) return urls;
        } catch (e) { continue; }
    }
    return [];
}

async function buscarEnUnsplash(termino) {
    if (!UNSPLASH_ACCESS_KEY) return [];
    try {
        const url = `https://api.unsplash.com/search/photos?query=${encodeURIComponent(termino)}&per_page=10`;
        const res = await fetch(url, { headers: { Authorization: `Client-ID ${UNSPLASH_ACCESS_KEY}` } });
        if (!res.ok) return [];
        const data = await res.json();
        return (data.results || []).map(r => ({ url: r.urls.regular, proveedor: 'unsplash' }));
    } catch (e) { return []; }
}

async function buscarEnPexels(termino) {
    if (!PEXELS_API_KEY) return [];
    try {
        const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(termino)}&per_page=10`;
        const res = await fetch(url, { headers: { Authorization: PEXELS_API_KEY } });
        if (!res.ok) return [];
        const data = await res.json();
        return (data.photos || []).map(p => ({ url: p.src.large, proveedor: 'pexels' }));
    } catch (e) { return []; }
}

async function buscarEnPixabay(termino) {
    if (!PIXABAY_API_KEY) return [];
    try {
        const url = `https://pixabay.com/api/?key=${PIXABAY_API_KEY}&q=${encodeURIComponent(termino)}&image_type=photo&per_page=10`;
        const res = await fetch(url);
        if (!res.ok) return [];
        const data = await res.json();
        return (data.hits || []).map(h => ({ url: h.largeImageURL, proveedor: 'pixabay' }));
    } catch (e) { return []; }
}

// --- Categorización simple (heurística por palabras clave, NO es "inteligencia" real) ---
// Esto solo reordena qué motor aparece primero según el tipo de búsqueda.
// Es una regla fija que tú puedes ajustar, no un análisis visual de calidad.
const CATEGORIAS = {
    naturaleza: ['flor', 'flores', 'paisaje', 'playa', 'montaña', 'árbol', 'animal', 'animales', 'planta'],
    personas: ['persona', 'gente', 'rostro', 'retrato', 'niño', 'niña', 'hombre', 'mujer'],
    diseño: ['logo', 'diseño', 'arte', 'ilustracion', 'ilustración', 'fondo', 'wallpaper', 'icono'],
};
// Para "naturaleza" y "diseño", Unsplash/Pexels/Pixabay suelen tener fotos más cuidadas.
// Para búsquedas genéricas, Google suele tener mayor variedad/cobertura.
function ordenSegunCategoria(termino) {
    const t = termino.toLowerCase();
    for (const [cat, palabras] of Object.entries(CATEGORIAS)) {
        if (palabras.some(p => t.includes(p))) {
            if (cat === 'naturaleza' || cat === 'diseño') return ['pixabay', 'unsplash', 'pexels', 'google'];
        }
    }
    return ['google', 'unsplash', 'pexels', 'pixabay']; // orden por defecto
}

// --- Función principal: consulta TODOS los motores a la vez y junta lo que sí responda ---
async function buscarImagenes(termino) {
    // Paso 1: caché permanente primero
    const enCache = await buscarEnCache(termino);
    if (enCache) {
        return { exito: true, resultados: enCache.resultados, deCache: true, actualizado: enCache.actualizado };
    }

    // Paso 2 y 3: todos los motores en paralelo — uno que falle no detiene a los demás
    const [google, unsplash, pexels, pixabay] = await Promise.all([
        buscarEnGoogle(termino),
        buscarEnUnsplash(termino),
        buscarEnPexels(termino),
        buscarEnPixabay(termino),
    ]);

    const porProveedor = { google, unsplash, pexels, pixabay };
    const orden = ordenSegunCategoria(termino);
    let combinados = [];
    for (const proveedor of orden) combinados = combinados.concat(porProveedor[proveedor] || []);

    if (combinados.length === 0) {
        return { exito: false, error: 'Ningún motor configurado devolvió resultados (revisa tus keys)' };
    }

    // Paso 4: guardar el combinado para la próxima vez
    await guardarEnCache(termino, combinados);

    return { exito: true, resultados: combinados, deCache: false };
}

// --- Paso 5: endpoint — agrégalo en tu app.js junto a los demás ---
// app.get('/api/buscar-imagenes', async (req, res) => {
//   const termino = req.query.q;
//   if (!termino) return res.status(400).json({ exito:false, error:'Falta el parámetro ?q=' });
//   res.json(await buscarImagenes(termino));
// });

module.exports = { buscarImagenes };
