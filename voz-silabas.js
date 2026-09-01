// ==========================================================
// VOZ POR SÍLABAS — versión gratuita de "clonación" de voz,
// sin necesitar GPU. El usuario graba ~115 sílabas una vez;
// para generar texto nuevo, se parte en sílabas y se unen las
// grabaciones con una transición suave (crossfade), aplicando
// además un ajuste de tono/velocidad para acercarlo a su voz.
//
// Aviso honesto: no suena como ElevenLabs/XTTS — suena como
// los sintetizadores de los años 90-2000 (reconociblemente
// "armado", no una voz neuronal). Es el escalón gratis; el de
// verdad realista queda para cuando haya ingresos.
//
// Necesita el paquete "fluent-ffmpeg" + "ffmpeg-static"
// (evita depender de si Render trae FFmpeg o no).
// ==========================================================

const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
ffmpeg.setFfmpegPath(ffmpegPath);

const DIR_SILABAS = path.join(__dirname, 'public', 'silabas');
if (!fs.existsSync(DIR_SILABAS)) fs.mkdirSync(DIR_SILABAS, { recursive: true });

// ── Lista base de sílabas a grabar (consonante + vocal) ──
const CONSONANTES = ['p','b','t','d','k','g','f','s','z','j','ch','m','n','ny','l','r','rr','y','v','c','q','h','x'];
const VOCALES = ['a','e','i','o','u'];
const SILABAS_BASE = CONSONANTES.flatMap(c => VOCALES.map(v => c + v))
    .concat(VOCALES); // también las vocales solas, para palabras que empiezan en vocal

function listaSilabas() {
    return SILABAS_BASE;
}

// ── Guardar la grabación de UNA sílaba ──
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

function rutaSilaba(vozId, silaba) {
    return path.join(DIR_SILABAS, vozId, `${silaba}.wav`);
}

async function guardarSilaba(vozId, silaba, buffer) {
    const dir = path.join(DIR_SILABAS, vozId);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(rutaSilaba(vozId, silaba), buffer);
}

function silabasGrabadas(vozId) {
    const dir = path.join(DIR_SILABAS, vozId);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).map(f => f.replace('.wav', ''));
}

// ── Partir un texto en sílabas aproximadas (heurística simple,
//    no un analizador fonético real — suficiente para este propósito) ──
function partirEnSilabas(texto) {
    const palabras = texto.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-zñ\s]/g, '').split(/\s+/).filter(Boolean);
    const silabas = [];
    for (const palabra of palabras) {
        let i = 0;
        while (i < palabra.length) {
            const dos = palabra.slice(i, i + 2);
            if (CONSONANTES.includes(palabra[i]) && VOCALES.includes(palabra[i + 1])) {
                silabas.push(dos);
                i += 2;
            } else if (VOCALES.includes(palabra[i])) {
                silabas.push(palabra[i]);
                i += 1;
            } else {
                i += 1; // letra no reconocida, se salta
            }
        }
        silabas.push('__pausa__'); // pausa breve entre palabras
    }
    return silabas;
}

// ── Unir los clips de sílabas con crossfade suave entre ellos ──
function unirConCrossfade(clips, salida) {
    return new Promise((resolve, reject) => {
        if (clips.length === 1) {
            fs.copyFileSync(clips[0], salida);
            return resolve(salida);
        }
        const comando = ffmpeg();
        clips.forEach(c => comando.input(c));

        // encadena acrossfade entre cada par consecutivo
        let filtro = '';
        let etiquetaPrevia = '0:a';
        for (let i = 1; i < clips.length; i++) {
            const etiquetaSalida = i === clips.length - 1 ? 'salida' : `cf${i}`;
            filtro += `[${etiquetaPrevia}][${i}:a]acrossfade=d=0.03:c1=tri:c2=tri[${etiquetaSalida}];`;
            etiquetaPrevia = etiquetaSalida;
        }
        filtro = filtro.slice(0, -1); // quita el ; final

        comando
            .complexFilter(filtro, 'salida')
            .audioCodec('libmp3lame')
            .on('error', reject)
            .on('end', () => resolve(salida))
            .save(salida);
    });
}

// ── Ajustar tono/velocidad del resultado final para acercarlo al usuario ──
function ajustarTonoVelocidad(entrada, salida, factorTono = 1.0, factorVelocidad = 1.0) {
    return new Promise((resolve, reject) => {
        ffmpeg(entrada)
            .audioFilters([
                `asetrate=44100*${factorTono},aresample=44100`,
                `atempo=${factorVelocidad}`
            ])
            .on('error', reject)
            .on('end', () => resolve(salida))
            .save(salida);
    });
}

// ── Función principal: texto → audio con las sílabas del usuario ──
async function generarConSilabas(vozId, texto, opciones = {}) {
    const disponibles = silabasGrabadas(vozId);
    if (!disponibles.length) {
        return { exito: false, error: 'Esta voz no tiene ninguna sílaba grabada todavía' };
    }

    const silabasTexto = partirEnSilabas(texto);
    const clips = [];
    const faltantes = [];

    for (const s of silabasTexto) {
        if (s === '__pausa__') continue; // por ahora se ignora, se podría insertar silencio real después
        const ruta = rutaSilaba(vozId, s);
        if (fs.existsSync(ruta)) {
            clips.push(ruta);
        } else {
            faltantes.push(s);
        }
    }

    if (!clips.length) {
        return { exito: false, error: 'Ninguna de las sílabas necesarias está grabada', faltantes };
    }

    const carpetaTmp = path.join(__dirname, 'tmp');
    if (!fs.existsSync(carpetaTmp)) fs.mkdirSync(carpetaTmp);
    const idTemp = crypto.randomBytes(8).toString('hex');
    const unido = path.join(carpetaTmp, `${idTemp}_unido.mp3`);
    const final = path.join(carpetaTmp, `${idTemp}_final.mp3`);

    try {
        await unirConCrossfade(clips, unido);
        await ajustarTonoVelocidad(
            unido, final,
            opciones.factorTono || 1.0,
            opciones.factorVelocidad || 1.0
        );

        const audioBuffer = fs.readFileSync(final);
        fs.unlinkSync(unido);
        fs.unlinkSync(final);

        return {
            exito: true,
            audio: audioBuffer.toString('base64'),
            faltantes, // sílabas que no estaban grabadas y se saltaron
            cobertura: `${clips.length}/${clips.length + faltantes.length} sílabas encontradas`
        };
    } catch (e) {
        return { exito: false, error: 'Error uniendo el audio: ' + e.message };
    }
}

module.exports = {
    listaSilabas,
    guardarSilaba,
    silabasGrabadas,
    generarConSilabas,
    upload
};
