// ============================================================
// AGENTE MONITOR — revisa tus servicios de Render
// y detecta errores antes de que tú los notes.
//
// Cómo funciona:
// 1. Cada X minutos revisa el /health de tu servidor
// 2. Revisa los logs de Render buscando errores
// 3. Si detecta algo, llama a tu /api/ia para analizar
//    el error y sugerir qué puede estar fallando
// 4. Te avisa (por ahora por consola — próximo paso: email/push)
//
// Ponlo en Render como un segundo servicio tipo "cron job"
// o agréga estas rutas a tu app.js existente.
// ============================================================

const SERVIDOR_PRINCIPAL = process.env.SERVIDOR_URL || 'https://mi-servidor-v2.onrender.com';
const INTERVALO_MS = parseInt(process.env.MONITOR_INTERVALO_MS) || 5 * 60 * 1000; // 5 min
const UMBRAL_ERRORES = parseInt(process.env.MONITOR_UMBRAL_ERRORES) || 3; // errores antes de avisar

// ── Estado del monitor ──
let estadoActual = {
  ultimaRevision: null,
  serviciosVivos: {},
  erroresConsecutivos: {},
  alertasEnviadas: [],
  historial: [] // últimas 100 revisiones
};

// ── Revisar un servicio por su URL de health ──
async function revisarServicio(nombre, url, timeoutMs = 8000) {
  const inicio = Date.now();
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(t);
    const tiempoMs = Date.now() - inicio;
    const data = await res.json().catch(() => ({}));

    return {
      nombre,
      vivo: res.ok,
      status: res.status,
      tiempoMs,
      data,
      error: null,
      timestamp: new Date().toISOString()
    };
  } catch(e) {
    clearTimeout(t);
    return {
      nombre,
      vivo: false,
      status: null,
      tiempoMs: Date.now() - inicio,
      data: null,
      error: e.name === 'AbortError' ? 'Timeout — no respondió en ' + timeoutMs + 'ms' : e.message,
      timestamp: new Date().toISOString()
    };
  }
}

// ── Analizar un error con tu IA ──
async function analizarErrorConIA(resultado) {
  try {
    const prompt = `Eres un agente de monitoreo de servidores. Analiza este error y da una explicación breve (máximo 3 líneas) de qué puede estar fallando y qué revisar:

Servicio: ${resultado.nombre}
URL: ${resultado.url || 'desconocida'}
Estado HTTP: ${resultado.status || 'sin respuesta'}
Error: ${resultado.error || 'sin contenido'}
Tiempo de respuesta: ${resultado.tiempoMs}ms

Responde en español, de forma concisa y práctica.`;

    const res = await fetch(`${SERVIDOR_PRINCIPAL}/api/ia`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt })
    });

    if (!res.ok) return 'No se pudo analizar el error con IA.';
    const data = await res.json();
    return data.respuesta || data.texto || data.resultado || 'Sin análisis disponible.';
  } catch(e) {
    return 'IA no disponible para analizar: ' + e.message;
  }
}

// ── Ciclo principal de monitoreo ──
async function cicloMonitor() {
  estadoActual.ultimaRevision = new Date().toISOString();

  // Lista de servicios a monitorear
  const servicios = [
    { nombre: 'Servidor Principal',  url: `${SERVIDOR_PRINCIPAL}/health` },
    { nombre: 'API IA',              url: `${SERVIDOR_PRINCIPAL}/api/estado` },
  ];

  // Agrega URLs adicionales desde env si las tienes
  if (process.env.MONITOR_URLS_EXTRA) {
    process.env.MONITOR_URLS_EXTRA.split(',').forEach(u => {
      u = u.trim();
      if (u) servicios.push({ nombre: u, url: u });
    });
  }

  const resultados = await Promise.all(
    servicios.map(s => revisarServicio(s.nombre, s.url).then(r => ({ ...r, url: s.url })))
  );

  // Guardar en historial (máx 100 revisiones)
  estadoActual.historial.unshift({
    timestamp: estadoActual.ultimaRevision,
    resultados: resultados.map(r => ({
      nombre: r.nombre, vivo: r.vivo,
      status: r.status, tiempoMs: r.tiempoMs
    }))
  });
  if (estadoActual.historial.length > 100) estadoActual.historial.pop();

  // Procesar cada resultado
  for (const resultado of resultados) {
    const prev = estadoActual.serviciosVivos[resultado.nombre];
    estadoActual.serviciosVivos[resultado.nombre] = resultado.vivo;

    if (!resultado.vivo) {
      // Incrementar contador de errores consecutivos
      estadoActual.erroresConsecutivos[resultado.nombre] =
        (estadoActual.erroresConsecutivos[resultado.nombre] || 0) + 1;

      const consecutivos = estadoActual.erroresConsecutivos[resultado.nombre];
      console.error(`❌ [MONITOR] ${resultado.nombre} CAÍDO (${consecutivos}x consecutivo) — ${resultado.error || 'HTTP ' + resultado.status}`);

      // Si supera el umbral, analizar con IA y crear alerta
      if (consecutivos >= UMBRAL_ERRORES) {
        const analisis = await analizarErrorConIA(resultado);
        const alerta = {
          id: Date.now(),
          tipo: 'servicio_caido',
          servicio: resultado.nombre,
          error: resultado.error || 'HTTP ' + resultado.status,
          consecutivos,
          analisisIA: analisis,
          timestamp: new Date().toISOString(),
          resuelta: false
        };
        estadoActual.alertasEnviadas.push(alerta);
        if (estadoActual.alertasEnviadas.length > 50) estadoActual.alertasEnviadas.shift();

        console.error(`🚨 [ALERTA] ${resultado.nombre}: ${analisis}`);
        // Próximo paso: mandar notificación real (email, push, webhook)
      }
    } else {
      // Se recuperó — resetear contador
      if (estadoActual.erroresConsecutivos[resultado.nombre] > 0) {
        console.log(`✅ [MONITOR] ${resultado.nombre} se recuperó`);
        estadoActual.erroresConsecutivos[resultado.nombre] = 0;

        // Marcar alertas anteriores como resueltas
        estadoActual.alertasEnviadas
          .filter(a => a.servicio === resultado.nombre && !a.resuelta)
          .forEach(a => { a.resuelta = true; a.resueltoEn = new Date().toISOString(); });
      }

      // Avisar si tarda demasiado (posible problema de rendimiento)
      if (resultado.tiempoMs > 3000) {
        console.warn(`⚠️ [MONITOR] ${resultado.nombre} lento: ${resultado.tiempoMs}ms`);
      } else {
        console.log(`✅ [MONITOR] ${resultado.nombre} OK — ${resultado.tiempoMs}ms`);
      }
    }
  }

  return resultados;
}

// ── Iniciar el ciclo de monitoreo ──
function iniciarMonitor() {
  console.log(`🤖 [MONITOR] Iniciado — revisando cada ${INTERVALO_MS / 60000} minutos`);
  cicloMonitor(); // primera revisión inmediata
  return setInterval(cicloMonitor, INTERVALO_MS);
}

// ── Rutas de API para consultar el estado del monitor ──
// Agrega estas rutas en tu app.js
function agregarRutasMonitor(app) {

  // Estado actual de todos los servicios
  app.get('/api/monitor/estado', (req, res) => {
    res.json({
      exito: true,
      ultimaRevision: estadoActual.ultimaRevision,
      servicios: Object.entries(estadoActual.serviciosVivos).map(([nombre, vivo]) => ({
        nombre,
        vivo,
        erroresConsecutivos: estadoActual.erroresConsecutivos[nombre] || 0
      })),
      alertasActivas: estadoActual.alertasEnviadas.filter(a => !a.resuelta).length
    });
  });

  // Alertas activas (servicios con problemas)
  app.get('/api/monitor/alertas', (req, res) => {
    res.json({
      exito: true,
      alertas: estadoActual.alertasEnviadas.filter(a => !a.resuelta),
      historialAlertas: estadoActual.alertasEnviadas.slice(0, 20)
    });
  });

  // Historial de revisiones
  app.get('/api/monitor/historial', (req, res) => {
    res.json({
      exito: true,
      historial: estadoActual.historial.slice(0, 20)
    });
  });

  // Forzar una revisión ahora mismo
  app.post('/api/monitor/revisar-ahora', async (req, res) => {
    const resultados = await cicloMonitor();
    res.json({ exito: true, resultados });
  });
}

module.exports = { iniciarMonitor, agregarRutasMonitor, cicloMonitor };
