'use strict';

/**
 * BDS Update Server
 *
 * Serviço mínimo e independente do Electron: hospeda o manifest.json central e os pacotes
 * de componentes internos do BDS (item 14-17 do plano de Dependency Manager).
 *
 * Rotas:
 *   GET  /manifest.json                                  -> manifesto atual
 *   GET  /components/:name/:version/:file                -> download do pacote de um componente
 *   GET  /health                                          -> verificação simples de saúde
 *
 * O manifest.json é gerado por `build-manifest.js` a partir da pasta `components/` e servido
 * como arquivo estático — este servidor NÃO monta o manifesto dinamicamente a cada request,
 * para manter o comportamento determinístico e auditável (o que está publicado é exatamente
 * o que foi gerado pelo build).
 *
 * Uso:
 *   node build-manifest.js --base-url https://updates.suaempresa.com --bds-version 1.0.3
 *   node server.js
 */

const path = require('node:path');
const fs = require('node:fs');
const express = require('express');

const PORT = process.env.PORT || 8787;
const MANIFEST_PATH = path.join(__dirname, 'manifest.json');
const COMPONENTS_DIR = path.join(__dirname, 'components');

const app = express();

app.disable('x-powered-by');

app.get('/health', (req, res) => {
  res.json({ status: 'ok', manifestPresent: fs.existsSync(MANIFEST_PATH) });
});

app.get('/manifest.json', (req, res) => {
  if (!fs.existsSync(MANIFEST_PATH)) {
    return res.status(404).json({ error: 'manifest.json ainda não foi gerado. Rode "npm run build-manifest" primeiro.' });
  }
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(MANIFEST_PATH);
});

// Download de pacotes de componentes. Servido explicitamente (não como estático genérico)
// para validar os parâmetros e evitar path traversal.
app.get('/components/:name/:version/:file', (req, res) => {
  const { name, version, file } = req.params;

  // Sanitização básica contra path traversal (nomes/versões/arquivos não podem conter
  // separadores de caminho).
  const isSafe = (s) => typeof s === 'string' && !s.includes('..') && !s.includes('/') && !s.includes('\\');
  if (!isSafe(name) || !isSafe(version) || !isSafe(file)) {
    return res.status(400).json({ error: 'Parâmetros inválidos.' });
  }

  const filePath = path.join(COMPONENTS_DIR, name, version, file);
  const resolvedComponentsDir = path.resolve(COMPONENTS_DIR);
  const resolvedFilePath = path.resolve(filePath);

  if (!resolvedFilePath.startsWith(resolvedComponentsDir)) {
    return res.status(400).json({ error: 'Caminho inválido.' });
  }

  if (!fs.existsSync(resolvedFilePath)) {
    return res.status(404).json({ error: 'Pacote não encontrado.' });
  }

  res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
  res.download(resolvedFilePath, file);
});

app.use((req, res) => {
  res.status(404).json({ error: 'Rota não encontrada.' });
});

app.listen(PORT, () => {
  console.log(`BDS Update Server ouvindo em http://localhost:${PORT}`);
  console.log(`Manifesto: http://localhost:${PORT}/manifest.json`);
  if (!fs.existsSync(MANIFEST_PATH)) {
    console.warn('Aviso: manifest.json ainda não existe. Rode "npm run build-manifest" para gerá-lo.');
  }
});
