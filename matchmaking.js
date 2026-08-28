// ============================================================
// MATCHMAKING GLOBAL REAL — usa Firebase Realtime Database
// como "sala de espera" para emparejar jugadores de verdad.
//
// Necesitas en Render → Environment:
//   FIREBASE_DB_URL=https://tu-proyecto-default-rtdb.firebaseio.com
//   FIREBASE_DB_SECRET=el secreto de tu Realtime Database
//     (Firebase Console → Configuración del proyecto → Cuentas de
//      servicio → Secretos de la base de datos)
//
// Nota honesta: el "secret" de Realtime Database es el método
// clásico/simple de autenticar. Funciona bien para este tamaño de
// proyecto, pero Google recomienda reglas de seguridad + tokens
// para producción a mayor escala. Para lo que estás armando ahora,
// esto es suficiente y no cuesta nada.
// ============================================================

const FIREBASE_DB_URL = process.env.FIREBASE_DB_URL;
const FIREBASE_DB_SECRET = process.env.FIREBASE_DB_SECRET;

function urlFirebase(ruta) {
    if (!FIREBASE_DB_URL) throw new Error('Falta FIREBASE_DB_URL en las variables de entorno');
    const auth = FIREBASE_DB_SECRET ? `?auth=${FIREBASE_DB_SECRET}` : '';
    return `${FIREBASE_DB_URL}/${ruta}.json${auth}`;
}

const TIEMPO_EXPIRA_MS = 60 * 1000; // si alguien lleva +60s en cola sin match, se ignora (probablemente se fue)

// ── Buscar pareja o anotarse en la cola de espera ──
async function buscarOEsperar(region, peerId, nombre) {
    const res = await fetch(urlFirebase(`matchmaking/${region}`));
    const cola = (await res.json()) || {};

    const ahora = Date.now();
    const esperando = Object.entries(cola).find(
        ([id, datos]) => id !== peerId && (ahora - datos.desde) < TIEMPO_EXPIRA_MS
    );

    if (esperando) {
        const [otroId, otroDatos] = esperando;
        const roomCode = Math.random().toString(36).substring(2, 8).toUpperCase();

        await Promise.all([
            fetch(urlFirebase(`matchmaking/${region}/${peerId}`), { method: 'DELETE' }),
            fetch(urlFirebase(`matchmaking/${region}/${otroId}`), { method: 'DELETE' }),
            fetch(urlFirebase(`matches/${otroId}`), {
                method: 'PUT',
                body: JSON.stringify({ roomCode, contrincante: nombre, isHost: false })
            })
        ]);

        return { matched: true, roomCode, isHost: true, contrincante: otroDatos.nombre };
    }

    // nadie esperando todavía: me anoto en la cola
    await fetch(urlFirebase(`matchmaking/${region}/${peerId}`), {
        method: 'PUT',
        body: JSON.stringify({ nombre, desde: ahora })
    });
    return { matched: false, esperando: true };
}

// ── El que ya estaba esperando usa esto para saber si alguien lo emparejó ──
async function revisarMatch(peerId) {
    const res = await fetch(urlFirebase(`matches/${peerId}`));
    const data = await res.json();
    if (data) {
        await fetch(urlFirebase(`matches/${peerId}`), { method: 'DELETE' });
        return { matched: true, ...data };
    }
    return { matched: false };
}

// ── Salir de la cola sin esperar más ──
async function cancelarBusqueda(region, peerId) {
    await fetch(urlFirebase(`matchmaking/${region}/${peerId}`), { method: 'DELETE' });
}

module.exports = { buscarOEsperar, revisarMatch, cancelarBusqueda };
