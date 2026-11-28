'use strict';
// Extracción segura de .vsix / .zip. NO ejecuta nada del paquete: solo lee bytes y escribe archivos.
// Rechaza: rutas con "..", rutas absolutas, enlaces simbólicos, archivos cifrados, ZIP64,
// bombas de compresión y paquetes gigantes.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const LIM = {
    maxZip: 30 * 1024 * 1024,         // tamaño del archivo subido
    maxTotal: 150 * 1024 * 1024,      // todo descomprimido
    maxArchivo: 25 * 1024 * 1024,     // un solo archivo descomprimido
    maxEntradas: 5000,
    maxRatio: 200,                    // descomprimido / comprimido (solo a partir de 1 MB)
};

function leerEntradas(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error('No es un ZIP válido');
    if (buf.length > LIM.maxZip) throw new Error('El paquete es demasiado grande (máx. 30 MB)');
    // Fin del directorio central (EOCD): se busca desde el final
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('No es un ZIP válido (sin directorio central)');
    const total = buf.readUInt16LE(eocd + 10);
    const tamCD = buf.readUInt32LE(eocd + 12);
    const offCD = buf.readUInt32LE(eocd + 16);
    if (total === 0xffff || tamCD === 0xffffffff || offCD === 0xffffffff) throw new Error('ZIP64 no soportado');
    if (total > LIM.maxEntradas) throw new Error('Demasiados archivos en el paquete');
    if (offCD + tamCD > buf.length) throw new Error('ZIP dañado');

    const entradas = [];
    let p = offCD;
    for (let n = 0; n < total; n++) {
        if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error('ZIP dañado (directorio central)');
        const flags = buf.readUInt16LE(p + 8);
        const metodo = buf.readUInt16LE(p + 10);
        const comp = buf.readUInt32LE(p + 20);
        const size = buf.readUInt32LE(p + 24);
        const lNombre = buf.readUInt16LE(p + 28);
        const lExtra = buf.readUInt16LE(p + 30);
        const lCom = buf.readUInt16LE(p + 32);
        const attrExt = buf.readUInt32LE(p + 38);
        const offLocal = buf.readUInt32LE(p + 42);
        const nombre = buf.toString('utf8', p + 46, p + 46 + lNombre);
        entradas.push({ nombre, flags, metodo, comp, size, attrExt, offLocal });
        p += 46 + lNombre + lExtra + lCom;
    }
    return entradas;
}

function nombreSeguro(nombre) {
    const n = String(nombre).replace(/\\/g, '/');
    if (n.includes('\0') || n.startsWith('/') || /^[A-Za-z]:/.test(n)) return null;
    const partes = n.split('/').filter((x) => x !== '' && x !== '.');
    if (partes.some((x) => x === '..')) return null;
    return partes.join('/');
}

// destino: carpeta vacía. prefijo: p. ej. "extension/" (los .vsix guardan todo ahí).
function extraerZip(buf, destino, opciones = {}) {
    const prefijo = opciones.prefijo || '';
    const entradas = leerEntradas(buf);
    const raiz = path.resolve(destino);
    fs.mkdirSync(raiz, { recursive: true });
    let totalBytes = 0;
    const archivos = [];

    for (const e of entradas) {
        if (e.nombre.endsWith('/')) continue; // carpeta
        const limpio = nombreSeguro(e.nombre);
        if (limpio === null) throw new Error('Ruta peligrosa dentro del paquete: ' + e.nombre.slice(0, 80));
        if (e.flags & 1) throw new Error('El paquete tiene archivos cifrados');
        if (((e.attrExt >>> 16) & 0xf000) === 0xa000) throw new Error('El paquete contiene enlaces simbólicos');
        if (e.metodo !== 0 && e.metodo !== 8) throw new Error('Método de compresión no soportado');
        if (e.size > LIM.maxArchivo) throw new Error('Un archivo del paquete es demasiado grande: ' + limpio.slice(0, 60));
        totalBytes += e.size;
        if (totalBytes > LIM.maxTotal) throw new Error('El paquete descomprimido es demasiado grande');
        if (e.size > 1024 * 1024 && e.comp > 0 && e.size / e.comp > LIM.maxRatio) throw new Error('Compresión sospechosa (posible bomba ZIP)');

        // Si hay prefijo, solo se extrae lo que está dentro de él (el resto, p. ej. [Content_Types].xml, se ignora)
        let rel = limpio;
        if (prefijo) {
            if (!(limpio + '').startsWith(prefijo)) continue;
            rel = limpio.slice(prefijo.length);
            if (!rel) continue;
        }

        // Cabecera local → dónde empiezan los datos
        const o = e.offLocal;
        if (o + 30 > buf.length || buf.readUInt32LE(o) !== 0x04034b50) throw new Error('ZIP dañado (cabecera local)');
        const ini = o + 30 + buf.readUInt16LE(o + 26) + buf.readUInt16LE(o + 28);
        const datosC = buf.subarray(ini, ini + e.comp);
        if (datosC.length !== e.comp) throw new Error('ZIP dañado (datos incompletos)');
        const datos = e.metodo === 0 ? datosC : zlib.inflateRawSync(datosC, { maxOutputLength: e.size + 1 });
        if (datos.length !== e.size) throw new Error('El tamaño de un archivo no coincide con lo declarado');

        const salida = path.resolve(raiz, rel);
        if (salida !== raiz && !salida.startsWith(raiz + path.sep)) throw new Error('Ruta fuera de la carpeta destino');
        fs.mkdirSync(path.dirname(salida), { recursive: true });
        fs.writeFileSync(salida, datos, { mode: 0o644 });
        archivos.push({ ruta: rel, bytes: datos.length });
    }
    return { archivos, totalBytes };
}

module.exports = { extraerZip, leerEntradas, LIM };
