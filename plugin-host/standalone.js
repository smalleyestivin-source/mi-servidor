'use strict';
// Servicio SEPARADO para ejecutar plugins. Arranque:  node plugin-host/standalone.js
// Recomendado: ponerlo en su propio servicio de Render, SIN claves de API ni bases de datos en su entorno.
// Así, aunque un plugin lograra salirse del aislamiento, no encontraría nada que robar.
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { attachPluginHost } = require('./index');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(cors());
app.use((req, res, next) => { res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer'); next(); });
app.use(express.json({ limit: '2mb' }));

attachPluginHost(app, { express, rateLimit });

app.get('/', (req, res) => res.json({ nombre: 'CodeIDE · servidor de plugins aislados', salud: '/ph/salud', buscar: '/ph/buscar?q=…', instalados: '/ph/instalados' }));
app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.use((req, res) => res.status(404).json({ ok: false, error: 'No encontrado' }));
app.use((err, req, res, _next) => res.status(err.status || 400).json({ ok: false, error: err.type === 'entity.too.large' ? 'Archivo demasiado grande' : 'Petición inválida' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log('🔌 Servidor de plugins aislados escuchando en el puerto ' + PORT));
