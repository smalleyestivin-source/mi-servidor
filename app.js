// ============================================================
// SERVIDOR DEFINITIVO - CONEXIÓN A 30+ SERVICIOS GRATIS
// ============================================================
// Autor: CodeIDE
// Versión: 3.0.0
// Licencia: MIT
// ============================================================

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { buscarImagenes } = require('./buscar-imagenes');
const { buscarOEsperar, revisarMatch, cancelarBusqueda } = require('./matchmaking');
const { buscarWeb, buscarVideos } = require('./buscar-web');
const vozSilabas = require('./voz-silabas');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ──
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

// ── Servidor de señalización PeerJS propio (para GameVerse u otros juegos P2P) ──
// Antes dependías del servidor gratuito de terceros por defecto de PeerJS.
// Esto lo reemplaza por uno tuyo, corriendo dentro de este mismo servidor.
// IMPORTANTE: usa el MISMO servidor HTTP que abre app.listen() más abajo —
// por eso se crea aquí una sola vez y se reutiliza (si no, quedarían dos
// servidores separados sin conectar entre sí).
const http = require('http');
const { ExpressPeerServer } = require('peer');
const httpServer = http.createServer(app);
const peerServer = ExpressPeerServer(httpServer, {
    path: '/',
    allow_discovery: false // evita que cualquiera liste los peers conectados
});
app.use('/peerjs', peerServer);

// ── Logging ──
const log = (msg, type = 'info') => {
    const timestamp = new Date().toISOString();
    const iconos = { info: '📘', exito: '✅', error: '❌', warning: '⚠️' };
    console.log(`${iconos[type] || '📘'} [${timestamp}] ${msg}`);
};

// ============================================================
// 1. LISTA DE SERVICIOS GRATUITOS (30+)
// ============================================================

const SERVICIOS = {
    // ── Ejecutores de código (9 servicios) ──
    piston: {
        nombre: 'Piston API',
        url: 'https://emkc.org/api/v2/piston/execute',
        tipo: 'ejecutor',
        limite: 'Ilimitado',
        lenguajes: ['python', 'javascript', 'java', 'c', 'cpp', 'go', 'rust', 'ruby', 'php']
    },
    judge0: {
        nombre: 'Judge0 CE',
        url: 'https://ce.judge0.com/submissions?wait=true',
        tipo: 'ejecutor',
        limite: 'Ilimitado',
        lenguajes: ['python', 'javascript', 'java', 'c', 'cpp', 'go', 'rust', 'ruby', 'php', 'swift', 'kotlin']
    },
    jdoodle: {
        nombre: 'JDoodle',
        url: 'https://api.jdoodle.com/v1/execute',
        tipo: 'ejecutor',
        limite: '200/día',
        lenguajes: ['python', 'javascript', 'java', 'c', 'cpp', 'go', 'rust', 'ruby', 'php', 'swift', 'kotlin']
    },
    codex: {
        nombre: 'CodeX API',
        url: 'https://codex-api.herokuapp.com/execute',
        tipo: 'ejecutor',
        limite: 'Ilimitado',
        lenguajes: ['python', 'javascript', 'java', 'c', 'cpp', 'go', 'rust', 'ruby', 'php']
    },
    replit: {
        nombre: 'Replit API',
        url: 'https://replit.com/api/v1/execute',
        tipo: 'ejecutor',
        limite: '1000/día',
        lenguajes: ['python', 'javascript', 'java', 'c', 'cpp', 'go', 'rust', 'ruby', 'php']
    },
    glot: {
        nombre: 'Glot.io',
        url: 'https://glot.io/api/run',
        tipo: 'ejecutor',
        limite: 'Ilimitado',
        lenguajes: ['python', 'javascript', 'java', 'c', 'cpp', 'go', 'rust', 'ruby', 'php']
    },
    codeboard: {
        nombre: 'Codeboard',
        url: 'https://codeboard.io/api/execute',
        tipo: 'ejecutor',
        limite: 'Ilimitado',
        lenguajes: ['python', 'javascript', 'java', 'c', 'cpp', 'go', 'rust', 'ruby', 'php']
    },
    codepile: {
        nombre: 'CodePile',
        url: 'https://codepile.com/api/run',
        tipo: 'ejecutor',
        limite: 'Ilimitado',
        lenguajes: ['python', 'javascript', 'java', 'c', 'cpp', 'go', 'rust', 'ruby', 'php']
    },
    codeven: {
        nombre: 'Codeven',
        url: 'https://codeven.herokuapp.com/execute',
        tipo: 'ejecutor',
        limite: 'Ilimitado',
        lenguajes: ['python', 'javascript', 'java', 'c', 'cpp', 'go', 'rust', 'ruby', 'php']
    },

    // ── APIs de IA y texto (7 servicios) ──
    groq: {
        nombre: 'Groq AI',
        url: 'https://api.groq.com/openai/v1/chat/completions',
        tipo: 'ia',
        limite: 'Gratuito con registro',
        modelos: ['llama-3.3-70b', 'mixtral-8x7b', 'gemma-7b']
    },
    openrouter: {
        nombre: 'OpenRouter',
        url: 'https://openrouter.ai/api/v1/chat/completions',
        tipo: 'ia',
        limite: 'Gratuito con registro',
        modelos: ['llama-3.1-8b', 'mixtral-8x7b', 'gemma-7b']
    },
    huggingface: {
        nombre: 'HuggingFace',
        // La URL vieja (api-inference.huggingface.co/models/) ya no se usa así.
        // HuggingFace unificó todo en este router, compatible con el mismo
        // formato que ya usas para Groq/OpenRouter — puedes poner cualquier
        // modelo de huggingface.co/models en el campo "modelo" al llamar /api/ia.
        url: 'https://router.huggingface.co/v1/chat/completions',
        tipo: 'ia',
        limite: 'Gratuito, ~1000 peticiones/día',
        modelos: ['meta-llama/Llama-3.2-3B-Instruct', 'Qwen/Qwen2.5-7B-Instruct', 'google/gemma-2-9b-it']
    },
    deepseek: {
        nombre: 'DeepSeek',
        url: 'https://api.deepseek.com/v1/chat/completions',
        tipo: 'ia',
        limite: 'Gratuito con registro',
        modelos: ['deepseek-chat', 'deepseek-coder']
    },
    mistral: {
        nombre: 'Mistral AI',
        url: 'https://api.mistral.ai/v1/chat/completions',
        tipo: 'ia',
        limite: 'Gratuito con registro',
        modelos: ['mistral-tiny', 'mistral-small', 'mistral-medium']
    },
    cohere: {
        nombre: 'Cohere',
        url: 'https://api.cohere.ai/v1/generate',
        tipo: 'ia',
        limite: 'Gratuito con registro',
        modelos: ['command', 'command-light']
    },
    together: {
        nombre: 'Together AI',
        url: 'https://api.together.xyz/v1/chat/completions',
        tipo: 'ia',
        limite: 'Gratuito con registro',
        modelos: ['llama-2-70b', 'mistral-7b']
    },

    // ── Bases de datos gratis (4 servicios) ──
    mongodb: {
        nombre: 'MongoDB Atlas',
        url: 'https://cloud.mongodb.com/api/atlas/v1.0',
        tipo: 'database',
        limite: '512MB gratis',
        drivers: ['mongoose', 'mongodb']
    },
    supabase: {
        nombre: 'Supabase',
        url: 'https://api.supabase.com/rest/v1',
        tipo: 'database',
        limite: '500MB gratis',
        drivers: ['postgresql']
    },
    firebase: {
        nombre: 'Firebase',
        url: 'https://firestore.googleapis.com/v1',
        tipo: 'database',
        limite: '1GB gratis',
        drivers: ['firebase-admin']
    },
    planetscale: {
        nombre: 'PlanetScale',
        url: 'https://api.planetscale.com/v1',
        tipo: 'database',
        limite: '5GB gratis',
        drivers: ['mysql']
    },

    // ── Almacenamiento gratis (4 servicios) ──
    supabase_storage: {
        nombre: 'Supabase Storage',
        url: 'https://api.supabase.com/storage/v1',
        tipo: 'storage',
        limite: '1GB gratis'
    },
    firebase_storage: {
        nombre: 'Firebase Storage',
        url: 'https://firebasestorage.googleapis.com/v0',
        tipo: 'storage',
        limite: '5GB gratis'
    },
    cloudinary: {
        nombre: 'Cloudinary',
        url: 'https://api.cloudinary.com/v1_1',
        tipo: 'storage',
        limite: '10GB gratis'
    },
    imgbb: {
        nombre: 'ImgBB',
        url: 'https://api.imgbb.com/1/upload',
        tipo: 'storage',
        limite: '32MB/archivo'
    },

    // ── Traducción y texto (3 servicios) ──
    libretranslate: {
        nombre: 'LibreTranslate',
        url: 'https://libretranslate.com/translate',
        tipo: 'translate',
        limite: 'Ilimitado',
        idiomas: ['es', 'en', 'fr', 'de', 'it', 'pt', 'ja', 'zh']
    },
    mymemory: {
        nombre: 'MyMemory',
        url: 'https://api.mymemory.translated.net/get',
        tipo: 'translate',
        limite: '1000/día',
        idiomas: ['es', 'en', 'fr', 'de', 'it', 'pt', 'ja', 'zh']
    },
    deepl: {
        nombre: 'DeepL (gratuito)',
        url: 'https://api-free.deepl.com/v2/translate',
        tipo: 'translate',
        limite: '500000/mes',
        idiomas: ['es', 'en', 'fr', 'de', 'it', 'pt', 'ja', 'zh']
    },

    // ── Herramientas dev (3 servicios) ──
    github: {
        nombre: 'GitHub API',
        url: 'https://api.github.com',
        tipo: 'dev',
        limite: '5000/día'
    },
    gitlab: {
        nombre: 'GitLab API',
        url: 'https://gitlab.com/api/v4',
        tipo: 'dev',
        limite: 'Ilimitado'
    },
    npm: {
        nombre: 'NPM Registry',
        url: 'https://registry.npmjs.org',
        tipo: 'dev',
        limite: 'Ilimitado'
    }
};

// ============================================================
// 2. GESTOR DE SERVICIOS
// ============================================================

// ── Keys reales del servidor, por proveedor (nunca las manda el navegador) ──
// Ponlas en Render → Environment con estos nombres exactos.
// Si el cliente manda su propia apiKey en la petición, esa tiene prioridad
// (por si algún día quieres dejar que alguien use su propia cuenta);
// si no manda nada, se usa automáticamente la del servidor.
const KEYS_SERVIDOR = {
    'Groq AI': process.env.GROQ_API_KEY,
    'OpenRouter': process.env.OPENROUTER_API_KEY,
    'HuggingFace': process.env.HUGGINGFACE_API_KEY,
    'DeepSeek': process.env.DEEPSEEK_API_KEY,
    'Mistral AI': process.env.MISTRAL_API_KEY,
    'Cohere': process.env.COHERE_API_KEY,
    'Together AI': process.env.TOGETHER_API_KEY,
    'MongoDB Atlas': process.env.MONGODB_API_KEY,
    'Supabase': process.env.SUPABASE_API_KEY,
    'Firebase': process.env.FIREBASE_API_KEY,
};

function resolverApiKey(servicio, apiKeyDelCliente) {
    return apiKeyDelCliente || KEYS_SERVIDOR[servicio.nombre] || '';
}

class GestorServicios {
    constructor() {
        this.servicios = SERVICIOS;
        this.estado = {};
        this.carga = {};
        this.cola = [];
        this.stats = {
            totalPeticiones: 0,
            exitos: 0,
            fallos: 0,
            porServicio: {}
        };
    }

    // ── Verificar todos los servicios ──
    async verificarTodos() {
        log('🔍 Verificando todos los servicios...', 'info');
        
        const resultados = {};
        for (const [id, servicio] of Object.entries(this.servicios)) {
            try {
                const disponible = await this.verificarServicio(id);
                this.estado[id] = disponible;
                resultados[id] = disponible;
                
                if (disponible) {
                    log(`✅ ${servicio.nombre}: Disponible`, 'exito');
                } else {
                    log(`❌ ${servicio.nombre}: No disponible`, 'error');
                }
            } catch (error) {
                this.estado[id] = false;
                resultados[id] = false;
                log(`❌ ${servicio.nombre}: Error - ${error.message}`, 'error');
            }
        }
        
        return resultados;
    }

    // ── Verificar un servicio específico ──
    async verificarServicio(id) {
        const servicio = this.servicios[id];
        if (!servicio) return false;

        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 3000);

            let response;
            switch (servicio.tipo) {
                case 'ejecutor':
                    response = await fetch(servicio.url, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            language: 'python',
                            version: '*',
                            files: [{ content: 'print(1)' }]
                        }),
                        signal: controller.signal
                    });
                    break;
                case 'translate':
                    response = await fetch(servicio.url, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            q: 'Hello',
                            source: 'en',
                            target: 'es'
                        }),
                        signal: controller.signal
                    });
                    break;
                default:
                    response = await fetch(servicio.url, {
                        method: 'HEAD',
                        signal: controller.signal
                    });
            }

            clearTimeout(timeout);
            return response.ok;
        } catch {
            return false;
        }
    }

    // ── Elegir el mejor servicio disponible ──
    elegirServicio(tipo = null) {
        const disponibles = Object.entries(this.servicios)
            .filter(([id]) => this.estado[id] === true)
            .filter(([id, s]) => tipo ? s.tipo === tipo : true);

        if (disponibles.length === 0) return null;

        // Ordenar por carga
        disponibles.sort((a, b) => {
            return (this.carga[a[0]] || 0) - (this.carga[b[0]] || 0);
        });

        const elegido = disponibles[0][0];
        this.carga[elegido] = (this.carga[elegido] || 0) + 1;
        
        return elegido;
    }

    // ── Ejecutar con múltiples servicios ──
    async ejecutar(tipo, datos) {
        this.stats.totalPeticiones++;
        
        // Intentar con servicios disponibles
        const maxIntentos = 5;
        let intentos = 0;
        let ultimoError = null;

        while (intentos < maxIntentos) {
            const servicioId = this.elegirServicio(tipo);
            if (!servicioId) break;

            const servicio = this.servicios[servicioId];
            
            try {
                log(`🔄 Ejecutando en ${servicio.nombre}...`, 'info');
                
                const resultado = await this.ejecutarEnServicio(servicioId, datos);
                
                // Reducir carga
                this.carga[servicioId] = Math.max(0, (this.carga[servicioId] || 1) - 1);
                this.stats.exitos++;
                this.stats.porServicio[servicioId] = (this.stats.porServicio[servicioId] || 0) + 1;
                
                return {
                    exito: true,
                    servicio: servicio.nombre,
                    servicioId: servicioId,
                    ...resultado
                };
                
            } catch (error) {
                ultimoError = error;
                this.estado[servicioId] = false;
                this.stats.fallos++;
                log(`⚠️ Falló ${servicio.nombre}: ${error.message}`, 'warning');
                intentos++;
            }
        }

        // Si todos fallan, encolar
        return this.encolarPeticion(tipo, datos);
    }

    // ── Ejecutar en un servicio específico ──
    async ejecutarEnServicio(servicioId, datos) {
        const servicio = this.servicios[servicioId];
        
        switch (servicio.tipo) {
            case 'ejecutor':
                return this.ejecutarCodigo(servicio, datos);
            case 'ia':
                return this.ejecutarIA(servicio, datos);
            case 'translate':
                return this.traducir(servicio, datos);
            case 'database':
                return this.accederBaseDatos(servicio, datos);
            case 'storage':
                return this.almacenarArchivo(servicio, datos);
            default:
                return this.peticionGenerica(servicio, datos);
        }
    }

    // ── Ejecutar código ──
    async ejecutarCodigo(servicio, datos) {
        const { codigo, lenguaje } = datos;
        
        let body;
        switch (servicio.nombre) {
            case 'Piston API':
                body = {
                    language: lenguaje,
                    version: '*',
                    files: [{ content: codigo }]
                };
                break;
            case 'Judge0 CE':
                body = {
                    language_id: this.getLanguageId(lenguaje),
                    source_code: codigo
                };
                break;
            case 'JDoodle':
                body = {
                    clientId: datos.clientId || 'TU_CLIENT_ID',
                    clientSecret: datos.clientSecret || 'TU_SECRET',
                    script: codigo,
                    language: lenguaje,
                    versionIndex: '0'
                };
                break;
            default:
                body = {
                    language: lenguaje,
                    code: codigo
                };
        }

        const response = await fetch(servicio.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();
        
        return {
            salida: this.extraerSalida(data),
            error: this.extraerError(data),
            raw: data
        };
    }

    // ── Ejecutar IA ──
    async ejecutarIA(servicio, datos) {
        const { prompt, modelo, systemPrompt } = datos;
        
        let body;
        switch (servicio.nombre) {
            case 'Groq AI':
                body = {
                    model: modelo || 'llama-3.3-70b-versatile',
                    messages: [
                        { role: 'system', content: systemPrompt || 'Eres un asistente útil' },
                        { role: 'user', content: prompt }
                    ]
                };
                break;
            case 'OpenRouter':
                // OpenRouter necesita el nombre del modelo con el prefijo del
                // proveedor (ej. "meta-llama/llama-3.3-70b-instruct"), no el
                // nombre corto que usa Groq — por eso va aparte.
                // Cuando actives OPENROUTER_MODELO_PREMIUM en Render, se usa
                // ese modelo de pago en vez del gratuito por defecto.
                body = {
                    model: modelo || process.env.OPENROUTER_MODELO_PREMIUM || 'meta-llama/llama-3.3-70b-instruct:free',
                    messages: [
                        { role: 'system', content: systemPrompt || 'Eres un asistente útil' },
                        { role: 'user', content: prompt }
                    ]
                };
                break;
            case 'HuggingFace':
                // Formato nuevo (compatible con chat completions, igual que
                // Groq/OpenRouter) — antes esto usaba el formato viejo
                // "inputs" que ya no es la forma recomendada.
                // Pásale cualquier modelo de huggingface.co/models en "modelo".
                body = {
                    model: modelo || 'meta-llama/Llama-3.2-3B-Instruct',
                    messages: [
                        { role: 'system', content: systemPrompt || 'Eres un asistente útil' },
                        { role: 'user', content: prompt }
                    ]
                };
                break;
            default:
                body = { prompt, max_tokens: 500 };
        }

        const response = await fetch(servicio.url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${resolverApiKey(servicio, datos.apiKey)}`
            },
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        return await response.json();
    }

    // ── Traducir texto ──
    async traducir(servicio, datos) {
        const { texto, origen, destino } = datos;
        
        let body;
        switch (servicio.nombre) {
            case 'LibreTranslate':
                body = { q: texto, source: origen, target: destino };
                break;
            case 'MyMemory':
                body = { q: texto, langpair: `${origen}|${destino}` };
                break;
            case 'DeepL':
                body = { text: [texto], target_lang: destino.toUpperCase() };
                break;
            default:
                body = { text: texto };
        }

        const response = await fetch(servicio.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        return await response.json();
    }

    // ── Acceder a base de datos ──
    async accederBaseDatos(servicio, datos) {
        const { coleccion, query, operacion } = datos;
        
        let body;
        switch (servicio.nombre) {
            case 'MongoDB Atlas':
                body = { collection: coleccion, query, operation: operacion };
                break;
            case 'Supabase':
                body = { table: coleccion, query };
                break;
            case 'Firebase':
                body = { collection: coleccion, query };
                break;
            default:
                body = { query };
        }

        const response = await fetch(servicio.url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${resolverApiKey(servicio, datos.apiKey)}`
            },
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        return await response.json();
    }

    // ── Almacenar archivo ──
    async almacenarArchivo(servicio, datos) {
        const { nombre, contenido, tipo } = datos;
        
        const formData = new FormData();
        formData.append('image', contenido);
        formData.append('name', nombre);

        const response = await fetch(servicio.url, {
            method: 'POST',
            body: formData
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        return await response.json();
    }

    // ── Petición genérica ──
    async peticionGenerica(servicio, datos) {
        const response = await fetch(servicio.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(datos)
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        return await response.json();
    }

        // ── Encolar petición ──
    encolarPeticion(tipo, datos) {
        return new Promise((resolve) => {
            this.cola.push({
                tipo,
                datos,
                resolve,
                timestamp: Date.now()
            });
            
            log(`📦 Petición encolada (${this.cola.length} en cola)`, 'warning');
            setTimeout(() => this.procesarCola(), 5000);
        });
    }

    // ── Procesar cola ──
    async procesarCola() {
        if (this.cola.length === 0) return;
        
        await this.verificarTodos();
        
        const disponibles = Object.values(this.estado).filter(v => v === true).length;
        
        if (disponibles === 0) {
            log('⏳ No hay servicios disponibles, esperando...', 'warning');
            setTimeout(() => this.procesarCola(), 10000);
            return;
        }
        
        const lote = this.cola.splice(0, Math.min(5, this.cola.length));
        
        for (const peticion of lote) {
            try {
                const resultado = await this.ejecutar(peticion.tipo, peticion.datos);
                peticion.resolve(resultado);
            } catch (error) {
                peticion.resolve({
                    exito: false,
                    error: error.message
                });
            }
        }
    }

    // ── Utilidades ──
    getLanguageId(lenguaje) {
        const ids = {
            'python': 71,
            'javascript': 63,
            'java': 62,
            'c': 50,
            'cpp': 54,
            'go': 95,
            'rust': 73,
            'ruby': 72,
            'php': 68,
            'swift': 83,
            'kotlin': 78,
            'typescript': 74
        };
        return ids[lenguaje] || 71;
    }

    extraerSalida(data) {
        return data.run?.stdout || data.stdout || data.output || data.result || '';
    }

    extraerError(data) {
        return data.run?.stderr || data.stderr || data.error || data.compile_output || '';
    }

    // ── Estadísticas ──
    obtenerEstadisticas() {
        const disponibles = Object.values(this.estado).filter(v => v === true).length;
        const total = Object.keys(this.servicios).length;
        
        return {
            servicios: {
                total,
                disponibles,
                caidos: total - disponibles
            },
            peticiones: this.stats,
            cola: this.cola.length,
            carga: this.carga,
            estado: this.estado
        };
    }
}

// ============================================================
// 3. INSTANCIA DEL GESTOR
// ============================================================

const gestor = new GestorServicios();

// ── Verificar servicios al inicio ──
gestor.verificarTodos().then(() => {
    log('✅ Todos los servicios verificados', 'exito');
    log(`📊 Servicios disponibles: ${Object.values(gestor.estado).filter(v => v).length}/${Object.keys(gestor.servicios).length}`, 'info');
});

// ============================================================
// 4. API ENDPOINTS
// ============================================================

// ── Endpoint principal ──
app.get('/', (req, res) => {
    res.json({
        nombre: 'Servidor Definitivo',
        version: '3.0.0',
        servicios: Object.keys(gestor.servicios).length,
        disponibles: Object.values(gestor.estado).filter(v => v).length,
        estado: gestor.estado,
        endpoints: {
            '/api/ejecutar': 'POST - Ejecutar código',
            '/api/ia': 'POST - IA y chatbots',
            '/api/traducir': 'POST - Traducción',
            '/api/database': 'POST - Base de datos',
            '/api/storage': 'POST - Almacenamiento',
            '/api/estado': 'GET - Estado de servicios',
            '/api/estadisticas': 'GET - Estadísticas'
        }
    });
});

// ============================================================
// SEGURIDAD DE ACCESO — llave propia de tu app + límite de uso
// Esto protege /api/ejecutar, /api/ia y /api/traducir para que
// solo tu app (o quien tenga tu APP_KEY) pueda usarlos, y para
// que aunque alguien la copie, no pueda abusar sin límite.
// ============================================================
const rateLimit = require('express-rate-limit');

const APP_KEY = process.env.APP_KEY; // ponla en Render → Environment. Distinta a las keys de los proveedores.

function verificarAppKey(req, res, next) {
    if (!APP_KEY) return next(); // si no configuraste ninguna todavía, no bloquea nada (modo abierto)
    const key = req.headers['x-app-key'];
    if (key !== APP_KEY) {
        return res.status(401).json({ exito: false, error: 'App key inválida o ausente' });
    }
    next();
}

const limitador = rateLimit({
    windowMs: 60 * 1000, // 1 minuto
    max: 20,             // máx. 20 peticiones por minuto por IP — ajusta a tu gusto
    standardHeaders: true,
    legacyHeaders: false,
    message: { exito: false, error: 'Demasiadas peticiones, espera un momento' }
});

app.use(['/api/ejecutar', '/api/ia', '/api/traducir'], verificarAppKey, limitador);

// ── Ejecutar código ──
app.post('/api/ejecutar', async (req, res) => {
    const { codigo, lenguaje } = req.body;
    
    if (!codigo) {
        return res.status(400).json({ error: 'Falta el código' });
    }

    const resultado = await gestor.ejecutar('ejecutor', {
        codigo,
        lenguaje: lenguaje || 'python'
    });

    res.json(resultado);
});

// ── IA y chatbots ──
app.post('/api/ia', async (req, res) => {
    const { prompt, modelo, systemPrompt, apiKey } = req.body;
    
    if (!prompt) {
        return res.status(400).json({ error: 'Falta el prompt' });
    }

    const resultado = await gestor.ejecutar('ia', {
        prompt,
        modelo,
        systemPrompt,
        apiKey
    });

    res.json(resultado);
});

// ── Traducción ──
app.post('/api/traducir', async (req, res) => {
    const { texto, origen, destino } = req.body;
    
    if (!texto) {
        return res.status(400).json({ error: 'Falta el texto' });
    }

    const resultado = await gestor.ejecutar('translate', {
        texto,
        origen: origen || 'auto',
        destino: destino || 'es'
    });

    res.json(resultado);
});

// ── Base de datos ──
app.post('/api/database', async (req, res) => {
    const { coleccion, query, operacion, apiKey } = req.body;
    
    if (!coleccion || !query) {
        return res.status(400).json({ error: 'Faltan datos' });
    }

    const resultado = await gestor.ejecutar('database', {
        coleccion,
        query,
        operacion: operacion || 'find',
        apiKey
    });

    res.json(resultado);
});

// ── Almacenamiento ──
app.post('/api/storage', async (req, res) => {
    const { nombre, contenido, tipo } = req.body;
    
    if (!nombre || !contenido) {
        return res.status(400).json({ error: 'Faltan datos' });
    }

    const resultado = await gestor.ejecutar('storage', {
        nombre,
        contenido,
        tipo: tipo || 'image'
    });

    res.json(resultado);
});

// ── Búsqueda de imágenes (caché local + rotación Google + fallback) ──
app.get('/api/buscar-imagenes', async (req, res) => {
    const termino = req.query.q;
    if (!termino) {
        return res.status(400).json({ exito: false, error: 'Falta el parámetro ?q=' });
    }
    const resultado = await buscarImagenes(termino);
    res.json(resultado);
});

// ── Estado de servicios ──
app.get('/api/estado', (req, res) => {
    res.json({
        estado: gestor.estado,
        disponibles: Object.values(gestor.estado).filter(v => v).length,
        total: Object.keys(gestor.servicios).length
    });
});

// ── Estadísticas ──
app.get('/api/estadisticas', (req, res) => {
    res.json(gestor.obtenerEstadisticas());
});

// ── Verificar todos los servicios ──
app.post('/api/verificar', async (req, res) => {
    const resultados = await gestor.verificarTodos();
    res.json(resultados);
});

// ── Listar servicios ──
app.get('/api/servicios', (req, res) => {
    const lista = Object.entries(gestor.servicios).map(([id, s]) => ({
        id,
        nombre: s.nombre,
        tipo: s.tipo,
        limite: s.limite,
        disponible: gestor.estado[id] || false
    }));
    res.json(lista);
});

// ── Health check ──
// ── Matchmaking global real (usa Firebase como sala de espera) ──
app.post('/api/matchmaking/buscar', async (req, res) => {
    const { region, peerId, nombre } = req.body;
    if (!peerId) return res.status(400).json({ error: 'Falta peerId' });
    try {
        res.json(await buscarOEsperar(region || 'ANY', peerId, nombre || 'Jugador'));
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/matchmaking/estado/:peerId', async (req, res) => {
    try {
        res.json(await revisarMatch(req.params.peerId));
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/matchmaking/cancelar', async (req, res) => {
    const { region, peerId } = req.body;
    try {
        await cancelarBusqueda(region || 'ANY', peerId);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── Voz por sílabas (versión gratuita, sin GPU) ──
app.get('/api/voz-silabas/lista', (req, res) => {
    res.json({ exito: true, silabas: vozSilabas.listaSilabas() });
});

app.post('/api/voz-silabas/:vozId/grabar/:silaba', vozSilabas.upload.single('audio'), async (req, res) => {
    if (!req.file) return res.status(400).json({ exito: false, error: 'No se recibió audio' });
    const { vozId, silaba } = req.params;
    if (!vozSilabas.listaSilabas().includes(silaba)) {
        return res.status(400).json({ exito: false, error: 'Esa sílaba no está en la lista' });
    }
    await vozSilabas.guardarSilaba(vozId, silaba, req.file.buffer);
    const grabadas = vozSilabas.silabasGrabadas(vozId);
    res.json({
        exito: true,
        silaba,
        progreso: `${grabadas.length}/${vozSilabas.listaSilabas().length}`
    });
});

app.get('/api/voz-silabas/:vozId/progreso', (req, res) => {
    const grabadas = vozSilabas.silabasGrabadas(req.params.vozId);
    res.json({ exito: true, grabadas: grabadas.length, total: vozSilabas.listaSilabas().length, faltan: vozSilabas.listaSilabas().filter(s => !grabadas.includes(s)) });
});

app.post('/api/voz-silabas/:vozId/generar', async (req, res) => {
    const { texto, factorTono, factorVelocidad } = req.body;
    if (!texto) return res.status(400).json({ exito: false, error: 'Falta el texto' });
    const resultado = await vozSilabas.generarConSilabas(req.params.vozId, texto, {
        factorTono: parseFloat(factorTono) || 1.0,
        factorVelocidad: parseFloat(factorVelocidad) || 1.0
    });
    res.json(resultado);
});


app.get('/api/buscar-web', async (req, res) => {
    const termino = req.query.q;
    if (!termino) return res.status(400).json({ exito: false, error: 'Falta el parámetro ?q=' });
    res.json(await buscarWeb(termino));
});

// ── Búsqueda de videos (YouTube, Vimeo, Dailymotion — vía SearXNG) ──
app.get('/api/buscar-videos', async (req, res) => {
    const termino = req.query.q;
    if (!termino) return res.status(400).json({ exito: false, error: 'Falta el parámetro ?q=' });
    res.json(await buscarVideos(termino));
});

// ── Buscador del VS Code Marketplace (proxy, sin límite de CORS) ──
app.post('/api/marketplace-search', async (req, res) => {
    try {
        const query = (req.body && typeof req.body.query === 'string') ? req.body.query.slice(0, 200) : '';

        const body = {
            filters: [{
                criteria: [
                    { filterType: 8, value: 'Microsoft.VisualStudio.Code' },
                    { filterType: 10, value: query || 'popular extensions' }
                ],
                pageNumber: 1,
                pageSize: 20,
                sortBy: query ? 0 : 4,
                sortOrder: 0
            }],
            assetTypes: [],
            flags: 914 // incluye, entre otras cosas, los links de descarga directa del .vsix
        };

        const upstream = await fetch('https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json;api-version=3.0-preview.1'
            },
            body: JSON.stringify(body)
        });

        if (!upstream.ok) {
            return res.status(502).json({ error: 'upstream_error', status: upstream.status });
        }

        const data = await upstream.json();
        res.json(data);

    } catch (err) {
        console.error('Error en /api/marketplace-search:', err);
        res.status(500).json({ error: 'proxy_error', message: String(err) });
    }
});

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        servicios: Object.values(gestor.estado).filter(v => v).length
    });
});

// ============================================================
// 5. INICIAR SERVIDOR
// ============================================================

httpServer.listen(PORT, '0.0.0.0', () => {
    log(`🚀 Servidor definitivo iniciado`, 'exito');
    log(`📡 Puerto: ${PORT}`, 'info');
    log(`🌐 Local: http://localhost:${PORT}`, 'info');
    log(`📱 Red: http://${getLocalIP()}:${PORT}`, 'info');
    log(`📊 Servicios cargados: ${Object.keys(gestor.servicios).length}`, 'info');
    log(`🎮 Señalización PeerJS propia en: /peerjs`, 'info');
});

// ── Obtener IP local ──
function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return '127.0.0.1';
}

// ============================================================
// 6. MANEJO DE ERRORES
// ============================================================

process.on('uncaughtException', (error) => {
    log(`💥 Error no capturado: ${error.message}`, 'error');
});

process.on('unhandledRejection', (reason) => {
    log(`💥 Promesa rechazada: ${reason}`, 'error');
});

// ============================================================
// MÓDULO DE VOCES Y TRADUCCIÓN EN CASCADA
// ============================================================
const https = require('https');
// (http ya se declaró arriba, junto al servidor de señalización PeerJS)

const PERSONAJES = {
  animados: {
    heroe:    { nombre: 'Héroe',          emoji: '🦸', descripcion: 'Voz fuerte y valiente',   clientRate: 1.0,  clientPitch: 1.0  },
    villano:  { nombre: 'Villano',         emoji: '🦹', descripcion: 'Voz grave y amenazante',  clientRate: 0.82, clientPitch: 0.82 },
    anciano:  { nombre: 'Anciano sabio',   emoji: '🧙', descripcion: 'Voz lenta y pausada',     clientRate: 0.75, clientPitch: 0.9  },
    guerrero: { nombre: 'Guerrero',        emoji: '⚔️', descripcion: 'Voz enérgica y rápida',   clientRate: 1.12, clientPitch: 1.05 },
    princesa: { nombre: 'Princesa',        emoji: '👸', descripcion: 'Voz dulce y suave',       clientRate: 0.95, clientPitch: 1.22 },
    monstruo: { nombre: 'Monstruo',        emoji: '👹', descripcion: 'Voz muy grave y lenta',   clientRate: 0.68, clientPitch: 0.72 }
  },
  profesionales: {
    locutor:     { nombre: 'Locutor de radio',        emoji: '📻', descripcion: 'Voz clara y proyectada',  clientRate: 1.05, clientPitch: 1.08 },
    documental:  { nombre: 'Narrador de documental',  emoji: '🎬', descripcion: 'Voz profunda y pausada',  clientRate: 0.88, clientPitch: 0.92 },
    reportero:   { nombre: 'Reportero',               emoji: '🎤', descripcion: 'Voz rápida y directa',    clientRate: 1.1,  clientPitch: 1.0  },
    noticias:    { nombre: 'Presentador de noticias', emoji: '📺', descripcion: 'Voz neutra y formal',     clientRate: 0.95, clientPitch: 1.02 },
    thriller:    { nombre: 'Narrador de thriller',     emoji: '🎭', descripcion: 'Voz intensa y misteriosa', clientRate: 0.85, clientPitch: 0.9  },
    infantil:    { nombre: 'Narrador infantil',        emoji: '🧸', descripcion: 'Voz alegre y animada',    clientRate: 1.1,  clientPitch: 1.35 }
  }
};

// ── Traducción en cascada: MyMemory → LibreTranslate → DeepL → Google (no oficial) ──
// Nota honesta: MyMemory es gratis y sin key. LibreTranslate público hoy pide key
// comprada para uso confiable (se intenta igual, pero puede fallar sin ella).
// DeepL usa tu key real desde variable de entorno (no una "DEMO" inventada).
// El paso de Google es un endpoint no documentado — funciona, pero sin garantía.
async function traducirCascada(texto, desde, hacia) {
  const errores = [];

  try {
    const result = await fetchJSON(
      `https://api.mymemory.translated.net/get?q=${encodeURIComponent(texto.slice(0,500))}&langpair=${desde}|${hacia}`,
      'GET'
    );
    if (result?.responseData?.translatedText) {
      const t = result.responseData.translatedText.replace(/&#39;/g,"'").replace(/&quot;/g,'"');
      if (!t.includes('MYMEMORY WARNING')) return { texto: t, motor: 'MyMemory', exito: true };
    }
  } catch(e) { errores.push('MyMemory: ' + e.message); }

  try {
    const libreKey = process.env.LIBRETRANSLATE_API_KEY;
    const body = JSON.stringify({
      q: texto.slice(0,1000), source: desde, target: hacia, format: 'text',
      ...(libreKey ? { api_key: libreKey } : {})
    });
    const result = await fetchJSON('https://libretranslate.com/translate', 'POST', body, { 'Content-Type': 'application/json' });
    if (result?.translatedText) return { texto: result.translatedText, motor: 'LibreTranslate', exito: true };
  } catch(e) { errores.push('LibreTranslate: ' + e.message); }

  try {
    const deeplKey = process.env.DEEPL_API_KEY;
    if (deeplKey) {
      const params = new URLSearchParams({ text: texto.slice(0,1000), source_lang: desde.toUpperCase(), target_lang: hacia.toUpperCase() });
      const result = await fetchJSON('https://api-free.deepl.com/v2/translate', 'POST', params.toString(), {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `DeepL-Auth-Key ${deeplKey}`
      });
      if (result?.translations?.[0]?.text) return { texto: result.translations[0].text, motor: 'DeepL', exito: true };
    }
  } catch(e) { errores.push('DeepL: ' + e.message); }

  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${desde}&tl=${hacia}&dt=t&q=${encodeURIComponent(texto.slice(0,500))}`;
    const result = await fetchJSON(url, 'GET');
    if (result?.[0]?.[0]?.[0]) {
      const traducido = result[0].map(x => x[0]).filter(Boolean).join('');
      return { texto: traducido, motor: 'Google (no oficial)', exito: true };
    }
  } catch(e) { errores.push('Google: ' + e.message); }

  return { texto: texto, motor: 'ninguno', exito: false, errores };
}

function fetchJSON(url, method = 'GET', body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed  = new URL(url);
    const isHttps = parsed.protocol === 'https:';
    const options = {
      hostname: parsed.hostname, port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search, method,
      headers: { 'User-Agent': 'TraductorPro/4.0', ...headers },
      timeout: 8000
    };
    if (body) options.headers['Content-Length'] = Buffer.byteLength(body);
    const lib = isHttps ? https : http;
    const req = lib.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch(e) { reject(new Error('JSON inválido: ' + data.slice(0,100))); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

function fetchBuffer(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TraductorPro/4.0)' }, timeout: 10000 }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject).on('timeout', () => reject(new Error('Timeout')));
  });
}

app.get('/api/personajes', (req, res) => {
  res.json({
    exito: true,
    categorias: {
      animados: Object.entries(PERSONAJES.animados).map(([id, p]) => ({ id, ...p })),
      profesionales: Object.entries(PERSONAJES.profesionales).map(([id, p]) => ({ id, ...p }))
    }
  });
});

// ── Cascada de TTS: Fish Audio → FreeTTS → Google (no oficial) ──
// Aviso honesto: Fish Audio hoy (2026) tiene una promoción de acceso
// gratis a su mejor modelo, pero es promocional, no garantizada para
// siempre — y su plan gratis normal es solo para uso personal, no
// comercial. Si un día deja de responder o cambia sus términos, la
// cascada simplemente cae a las siguientes opciones sin romper nada.
async function generarAudioFishAudio(texto, idioma) {
    const key = process.env.FISH_AUDIO_API_KEY;
    if (!key) throw new Error('Sin FISH_AUDIO_API_KEY configurada');
    const res = await fetch('https://api.fish.audio/v1/tts', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: texto, format: 'mp3' })
    });
    if (!res.ok) throw new Error('Fish Audio respondió ' + res.status);
    const buffer = Buffer.from(await res.arrayBuffer());
    if (!buffer.length) throw new Error('Fish Audio devolvió audio vacío');
    return buffer;
}

async function generarAudioFreeTTS(texto, idioma) {
    const headers = { 'Content-Type': 'application/json' };
    if (process.env.FREETTS_API_KEY) headers['x-api-key'] = process.env.FREETTS_API_KEY;
    const res = await fetch('https://freetts.org/api/v1/tts', {
        method: 'POST',
        headers,
        body: JSON.stringify({ text: texto, language: idioma })
    });
    if (!res.ok) throw new Error('FreeTTS respondió ' + res.status);
    const buffer = Buffer.from(await res.arrayBuffer());
    if (!buffer.length) throw new Error('FreeTTS devolvió audio vacío');
    return buffer;
}

async function generarAudioGoogle(texto, idioma) {
    const chunks = [];
    let chunk = '';
    for (const p of texto.split(' ')) {
        if ((chunk + ' ' + p).length > 190) { if (chunk) chunks.push(chunk.trim()); chunk = p; }
        else chunk += ' ' + p;
    }
    if (chunk.trim()) chunks.push(chunk.trim());

    const buffers = [];
    for (const c of chunks) {
        const url = `https://translate.googleapis.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(c)}&tl=${idioma}&client=gtx`;
        buffers.push(await fetchBuffer(url));
    }
    return Buffer.concat(buffers);
}

async function generarAudioConCascada(texto, idioma) {
    const motores = [
        { nombre: 'Fish Audio', fn: generarAudioFishAudio },
        { nombre: 'FreeTTS', fn: generarAudioFreeTTS },
        { nombre: 'Google (no oficial)', fn: generarAudioGoogle }
    ];
    let ultimoError = null;
    for (const motor of motores) {
        try {
            const audio = await motor.fn(texto, idioma);
            return { audio, motor: motor.nombre };
        } catch (e) {
            log(`⚠️ ${motor.nombre} falló para TTS: ${e.message}`, 'warning');
            ultimoError = e;
            continue;
        }
    }
    throw ultimoError || new Error('Ningún motor de voz respondió');
}

app.post('/api/tts', async (req, res) => {
  const { texto, idioma = 'es', personaje, categoria } = req.body;
  if (!texto || !texto.trim()) return res.status(400).json({ error: 'Texto requerido' });

  let config = { clientRate: 1.0, clientPitch: 1.0 };
  if (personaje && categoria && PERSONAJES[categoria]?.[personaje]) config = PERSONAJES[categoria][personaje];

  const lang = idioma.split('-')[0];
  try {
    const { audio, motor } = await generarAudioConCascada(texto, lang);
    res.set({
      'Content-Type': 'audio/mpeg', 'Content-Length': audio.length, 'Cache-Control': 'no-cache',
      'X-Client-Rate': config.clientRate, 'X-Client-Pitch': config.clientPitch,
      'X-Motor-TTS': motor
    });
    res.send(audio);
  } catch(e) {
    res.status(500).json({ error: 'Error generando audio: ' + e.message });
  }
});

app.post('/api/traducir-pro', async (req, res) => {
  const { texto, desde = 'es', hacia = 'en' } = req.body;
  if (!texto || !texto.trim()) return res.status(400).json({ error: 'Texto requerido' });
  try {
    res.json(await traducirCascada(texto.trim(), desde, hacia));
  } catch(e) {
    res.status(500).json({ error: e.message, exito: false });
  }
});

app.post('/api/narrador', async (req, res) => {
  const { texto, desde = 'es', hacia = 'en', personaje, categoria } = req.body;
  if (!texto || !texto.trim()) return res.status(400).json({ error: 'Texto requerido' });

  try {
    const trad = await traducirCascada(texto.trim(), desde, hacia);
    if (!trad.exito) return res.status(500).json({ error: 'No se pudo traducir', ...trad });

    let config = { clientRate: 1.0, clientPitch: 1.0 };
    if (personaje && categoria && PERSONAJES[categoria]?.[personaje]) config = PERSONAJES[categoria][personaje];

    const lang = hacia.split('-')[0];
    const chunks = [];
    let chunk = '';
    for (const p of trad.texto.split(' ')) {
      if ((chunk + ' ' + p).length > 190) { if (chunk) chunks.push(chunk.trim()); chunk = p; }
      else chunk += ' ' + p;
    }
    if (chunk.trim()) chunks.push(chunk.trim());

    const buffers = [];
    for (const c of chunks) {
      const url = `https://translate.googleapis.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(c)}&tl=${lang}&client=gtx`;
      buffers.push(await fetchBuffer(url));
    }
    const audio = Buffer.concat(buffers);

    res.set({
      'Content-Type': 'audio/mpeg', 'Content-Length': audio.length,
      'X-Texto-Traducido': encodeURIComponent(trad.texto), 'X-Motor-Traduccion': trad.motor,
      'X-Client-Rate': config.clientRate, 'X-Client-Pitch': config.clientPitch
    });
    res.send(audio);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

log('🎙️ Módulo de voces y traducción en cascada cargado', 'exito');
log(`🎭 Personajes: ${Object.keys(PERSONAJES.animados).length + Object.keys(PERSONAJES.profesionales).length}`, 'info');


// ============================================================
// MÓDULO COMPLETO: BIBLIOTECA DE VOCES — Traductor Pro v4
// ============================================================
// INSTRUCCIONES:
// 1. npm install multer
// 2. Copiar este código al final de tu app.js
//    ANTES de cualquier module.exports
// ============================================================

const multer = require('multer');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');

// ── Directorio de audios (esto SÍ se borra si Render reinicia el servicio —
// es una limitación del plan gratis, ya la vimos con el caché de imágenes.
// Los datos importantes — la lista de voces, reseñas y usos — sí quedan a
// salvo en MongoDB, que es permanente) ──
const VOICES_DIR = path.join(__dirname, 'public', 'voces');
if (!fs.existsSync(VOICES_DIR)) fs.mkdirSync(VOICES_DIR, { recursive: true });

// ── "Base de datos" en MongoDB en vez de un archivo JSON local ──
// Usa el mismo MONGODB_URI que ya configuraste para el caché de imágenes.
let clienteMongoVoces = null;
async function dbVoces() {
    if (!process.env.MONGODB_URI) return null;
    if (!clienteMongoVoces) {
        clienteMongoVoces = new MongoClient(process.env.MONGODB_URI);
        await clienteMongoVoces.connect();
    }
    return clienteMongoVoces.db('mi_servidor');
}

// Memoria de respaldo si no hay Mongo configurado (no persiste entre reinicios)
let memoriaVoces = { voces: [], reseñas: {}, usos: {} };

async function leerDB() {
    const db = await dbVoces();
    if (!db) return memoriaVoces;
    const [voces, reseñasArr, usosArr] = await Promise.all([
        db.collection('voces').find({}).toArray(),
        db.collection('voces_resenas').find({}).toArray(),
        db.collection('voces_usos').find({}).toArray()
    ]);
    const reseñas = {};
    reseñasArr.forEach(r => { reseñas[r._id] = r.lista || []; });
    const usos = {};
    usosArr.forEach(u => { usos[u._id] = u.cantidad || 0; });
    return { voces, reseñas, usos };
}

async function guardarVoz(voz) {
    const db = await dbVoces();
    if (!db) { memoriaVoces.voces.push(voz); return; }
    await db.collection('voces').updateOne({ id: voz.id }, { $set: voz }, { upsert: true });
}

async function eliminarVoz(id) {
    const db = await dbVoces();
    if (!db) { memoriaVoces.voces = memoriaVoces.voces.filter(v => v.id !== id); return; }
    await db.collection('voces').deleteOne({ id });
}

async function guardarReseña(vozId, reseña) {
    const db = await dbVoces();
    if (!db) {
        if (!memoriaVoces.reseñas[vozId]) memoriaVoces.reseñas[vozId] = [];
        memoriaVoces.reseñas[vozId].push(reseña);
        return memoriaVoces.reseñas[vozId];
    }
    await db.collection('voces_resenas').updateOne(
        { _id: vozId },
        { $push: { lista: reseña } },
        { upsert: true }
    );
    const doc = await db.collection('voces_resenas').findOne({ _id: vozId });
    return doc.lista;
}

async function registrarUso(clave, incremento = 1) {
    const db = await dbVoces();
    if (!db) {
        memoriaVoces.usos[clave] = (memoriaVoces.usos[clave] || 0) + incremento;
        return memoriaVoces.usos[clave];
    }
    const res = await db.collection('voces_usos').findOneAndUpdate(
        { _id: clave },
        { $inc: { cantidad: incremento } },
        { upsert: true, returnDocument: 'after' }
    );
    return res.value.cantidad;
}

// ── Multer: subida de audio ──
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, VOICES_DIR),
  filename: (req, file, cb) => {
    const id  = crypto.randomBytes(10).toString('hex');
    const ext = path.extname(file.originalname) || '.webm';
    cb(null, `voz_${id}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const ok = ['audio/webm','audio/mp4','audio/mpeg','audio/ogg','audio/wav','audio/aac'];
    ok.includes(file.mimetype) ? cb(null, true) : cb(new Error('Solo audio'));
  }
});

// ── Servir audios estáticos ──
app.use('/voces', express.static(VOICES_DIR, {
  setHeaders: (res) => {
    res.set('Access-Control-Allow-Origin', '*');
  }
}));

// ============================================================
// GET /api/voces — Listar voces con filtros
// Query: genero, categoria, idioma, buscar, orden
// ============================================================
app.get('/api/voces', async (req, res) => {
  const db = await leerDB();
  const { genero, categoria, idioma, buscar, orden = 'populares' } = req.query;

  let voces = db.voces.filter(v => v.activa !== false);

  if (genero)    voces = voces.filter(v => v.genero    === genero);
  if (categoria) voces = voces.filter(v => v.categoria === categoria);
  if (idioma)    voces = voces.filter(v => v.idioma    === idioma);
  if (buscar) {
    const q = buscar.toLowerCase();
    voces = voces.filter(v =>
      v.nombre.toLowerCase().includes(q) ||
      (v.creador || '').toLowerCase().includes(q) ||
      (v.descripcion || '').toLowerCase().includes(q)
    );
  }

  // Agregar stats
  voces = voces.map(v => {
    const reseñasVoz = db.reseñas[v.id] || [];
    const rating = reseñasVoz.length
      ? reseñasVoz.reduce((a, r) => a + r.estrellas, 0) / reseñasVoz.length
      : 0;
    return { ...v, usos: db.usos[v.id] || 0, rating: parseFloat(rating.toFixed(1)), reviews: reseñasVoz.length };
  });

  // Ordenar
  if (orden === 'populares')  voces.sort((a, b) => b.usos   - a.usos);
  if (orden === 'rating')     voces.sort((a, b) => b.rating - a.rating);
  if (orden === 'recientes')  voces.sort((a, b) => new Date(b.fecha) - new Date(a.fecha));

  res.json({ exito: true, total: voces.length, voces });
});

// ============================================================
// GET /api/voces/:id — Detalle de una voz
// ============================================================
app.get('/api/voces/:id', async (req, res) => {
  const db  = await leerDB();
  const voz = db.voces.find(v => v.id === req.params.id);
  if (!voz) return res.status(404).json({ error: 'No encontrada' });

  const reseñas = db.reseñas[voz.id] || [];
  const rating  = reseñas.length
    ? reseñas.reduce((a, r) => a + r.estrellas, 0) / reseñas.length
    : 0;

  res.json({
    exito: true,
    voz: { ...voz, usos: db.usos[voz.id] || 0, rating: parseFloat(rating.toFixed(1)), reviews: reseñas.length },
    reseñas: reseñas.slice(-10) // últimas 10 reseñas
  });
});

// ============================================================
// POST /api/voces/subir — Subir voz nueva
// Form fields: nombre, creador, genero, idioma, categoria,
//              tipo, limite_diario, descripcion, frases_grabadas
// File field:  audio
// ============================================================
app.post('/api/voces/subir', limitador, upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibió audio' });

  const {
    nombre          = 'Voz sin nombre',
    creador         = 'Anónimo',
    idioma          = 'es',
    genero          = 'neutro',
    categoria       = 'general',
    descripcion     = '',
    tipo            = 'gratis',
    limite_diario   = 0,
    frases_grabadas = 0
  } = req.body;

  const id = crypto.randomBytes(12).toString('hex');

  const voz = {
    id,
    nombre:          nombre.trim().slice(0, 60),
    creador:         creador.trim().slice(0, 40),
    idioma,
    genero,
    categoria,
    descripcion:     descripcion.trim().slice(0, 200),
    tipo,
    limite_diario:   parseInt(limite_diario) || 0,
    frases_grabadas: parseInt(frases_grabadas) || 0,
    archivo:         req.file.filename,
    url:             `/voces/${req.file.filename}`,
    tamaño:          req.file.size,
    fecha:           new Date().toISOString(),
    activa:          true
  };

  await guardarVoz(voz);

  console.log(`🎙️ Nueva voz: "${nombre}" por ${creador} (${idioma}/${genero})`);
  res.json({ exito: true, voz });
});

// ============================================================
// POST /api/voces/:id/usar — Registrar uso
// ============================================================
app.post('/api/voces/:id/usar', async (req, res) => {
  const db  = await leerDB();
  const voz = db.voces.find(v => v.id === req.params.id);
  if (!voz) return res.status(404).json({ error: 'No encontrada' });

  // Verificar límite diario
  if (voz.tipo === 'limite' && voz.limite_diario > 0) {
    const hoy   = new Date().toDateString();
    const clave = `${voz.id}_${hoy}`;
    const hoy_n = db.usos[clave] || 0;

    if (hoy_n >= voz.limite_diario) {
      return res.status(429).json({
        error:    'Límite diario alcanzado',
        limite:   voz.limite_diario,
        usosHoy:  hoy_n,
        resetEn:  'Mañana'
      });
    }
    await registrarUso(clave, 1);
  }

  const totalUsos = await registrarUso(voz.id, 1);

  res.json({
    exito:  true,
    url:    voz.url,
    usos:   totalUsos,
    tipo:   voz.tipo
  });
});

// ============================================================
// POST /api/voces/:id/review — Agregar reseña
// Body: { estrellas (1-5), comentario }
// ============================================================
app.post('/api/voces/:id/review', async (req, res) => {
  const { estrellas, comentario = '' } = req.body;
  const stars = parseInt(estrellas);

  if (!stars || stars < 1 || stars > 5) {
    return res.status(400).json({ error: 'Estrellas debe ser 1-5' });
  }

  const db  = await leerDB();
  const voz = db.voces.find(v => v.id === req.params.id);
  if (!voz) return res.status(404).json({ error: 'No encontrada' });

  const reseñas = await guardarReseña(voz.id, {
    estrellas: stars,
    comentario: comentario.trim().slice(0, 300),
    fecha: new Date().toISOString()
  });

  const rating = reseñas.reduce((a, r) => a + r.estrellas, 0) / reseñas.length;

  res.json({
    exito:   true,
    rating:  parseFloat(rating.toFixed(1)),
    reviews: reseñas.length
  });
});

// ============================================================
// DELETE /api/voces/:id — Eliminar voz (por el creador)
// Body: { nombre_creador } — verificación básica
// ============================================================
app.delete('/api/voces/:id', async (req, res) => {
  const { nombre_creador } = req.body;
  const db  = await leerDB();
  const voz = db.voces.find(v => v.id === req.params.id);
  if (!voz) return res.status(404).json({ error: 'No encontrada' });

  // ── Verificación real (antes el comentario lo prometía pero el código
  // nunca lo revisaba — cualquiera podía borrar la voz de cualquiera) ──
  if (!nombre_creador || nombre_creador.trim().toLowerCase() !== voz.creador.trim().toLowerCase()) {
    return res.status(403).json({ error: 'El nombre del creador no coincide, no se puede borrar' });
  }

  // Eliminar archivo de audio
  try {
    fs.unlinkSync(path.join(VOICES_DIR, voz.archivo));
  } catch(e) { /* ya fue borrado */ }

  await eliminarVoz(voz.id);

  res.json({ exito: true, mensaje: `Voz "${voz.nombre}" eliminada` });
});

// ============================================================
// GET /api/voces/stats/resumen — Estadísticas globales
// ============================================================
app.get('/api/voces/stats/resumen', async (req, res) => {
  const db = await leerDB();
  const voces = db.voces.filter(v => v.activa !== false);

  const contarPor = (campo) => voces.reduce((acc, v) => {
    acc[v[campo]] = (acc[v[campo]] || 0) + 1; return acc;
  }, {});

  const masUsadas = voces
    .map(v => ({ id: v.id, nombre: v.nombre, creador: v.creador, usos: db.usos[v.id] || 0 }))
    .sort((a, b) => b.usos - a.usos)
    .slice(0, 10);

  const mejorRating = voces
    .map(v => {
      const r = db.reseñas[v.id] || [];
      const rating = r.length ? r.reduce((a, x) => a + x.estrellas, 0) / r.length : 0;
      return { id: v.id, nombre: v.nombre, rating: parseFloat(rating.toFixed(1)), reviews: r.length };
    })
    .filter(v => v.reviews > 0)
    .sort((a, b) => b.rating - a.rating)
    .slice(0, 5);

  res.json({
    total:         voces.length,
    por_genero:    contarPor('genero'),
    por_idioma:    contarPor('idioma'),
    por_categoria: contarPor('categoria'),
    por_tipo:      contarPor('tipo'),
    mas_usadas:    masUsadas,
    mejor_rating:  mejorRating
  });
});

// ============================================================
// POST /api/voces/clonar — Preparar datos para clonación futura
// (Guarda las grabaciones de frases para cuando se integre
//  un motor de clonación como Coqui TTS o RVC)
// Body multipart: audio_0, audio_1 ... audio_7, + metadata
// ============================================================
const uploadMultiple = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(VOICES_DIR, 'clones', req.body.id || 'tmp');
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => cb(null, file.fieldname + '.webm')
  }),
  limits: { fileSize: 5 * 1024 * 1024 }
});

// NOTA: igual que los audios normales, estos archivos de clonación viven en
// el disco temporal de Render — se pierden si el servicio reinicia. Como es
// contenido "pendiente de procesar" (no el catálogo final), es menos grave
// que perder la base de datos, pero igual vale la pena saberlo.
app.post('/api/voces/clonar', limitador, uploadMultiple.any(), (req, res) => {
  const { nombre = 'Voz clonada', creador = 'Anónimo', idioma = 'es' } = req.body;
  const id = crypto.randomBytes(10).toString('hex');

  // Guardar metadata de la voz a clonar
  const clonesDir = path.join(VOICES_DIR, 'clones', id);
  fs.mkdirSync(clonesDir, { recursive: true });

  const meta = {
    id,
    nombre,
    creador,
    idioma,
    archivos: req.files.map(f => f.filename),
    fecha: new Date().toISOString(),
    estado: 'pendiente'
    // TODO: cuando se integre Coqui TTS o RVC:
    // 1. Enviar los archivos a proceso de entrenamiento
    // 2. Guardar el modelo resultante
    // 3. Actualizar estado a 'lista'
  };

  fs.writeFileSync(path.join(clonesDir, 'meta.json'), JSON.stringify(meta, null, 2));

  res.json({
    exito: true,
    id,
    mensaje: 'Grabaciones recibidas. La voz clonada estará lista próximamente.',
    archivos: req.files.length
  });
});

// ============================================================
// Logs de inicio
// ============================================================
console.log('✅ Módulo de biblioteca de voces cargado');
console.log(`📁 Voces en: ${VOICES_DIR}`);
console.log(`💾 DB en:    ${DB_FILE}`);
console.log('');
console.log('Endpoints disponibles:');
console.log('  GET    /api/voces              — Listar (filtros: genero, categoria, idioma, buscar, orden)');
console.log('  GET    /api/voces/:id          — Detalle + reseñas');
console.log('  POST   /api/voces/subir        — Subir nueva voz');
console.log('  POST   /api/voces/:id/usar     — Registrar uso');
console.log('  POST   /api/voces/:id/review   — Agregar reseña');
console.log('  DELETE /api/voces/:id          — Eliminar voz');
console.log('  GET    /api/voces/stats/resumen — Estadísticas');
console.log('  POST   /api/voces/clonar       — Guardar grabaciones para clonar');

// ============================================================
// FIN DEL MÓDULO
// ============================================================

// ============================================================
// 7. EXPORTAR PARA USO EN OTROS MÓDULOS
// ============================================================

module.exports = {
    app,
    gestor,
    SERVICIOS,
    PERSONAJES,
    traducirCascada
};

// ============================================================
// FIN DEL CÓDIGO DEFINITIVO
// ============================================================