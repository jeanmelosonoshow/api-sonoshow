import { createHash, timingSafeEqual } from 'node:crypto';
import { AppError, loadConfig, requiredEnv } from './config.js';
import { normalizeRows, saleFilters, filterSales } from './data.js';
import { createCache } from './cache.js';
import { createFirebirdReader } from './firebird.js';
import { salesWindow, withinWindow, intersectFilters, directQueryWindow, defaultDirectStart, assertDirectStart, assertSnapshotWindow, assertCoverage } from './sales-window.js';

function authorize(req, env, tokenName) {
  const token = requiredEnv(env, tokenName);
  if (token.length < 32 || (env.API_BEARER_TOKEN && env.API_BEARER_TOKEN === env.SYNC_BEARER_TOKEN)) {
    throw new AppError(503, 'TOKEN_CONFIG_INVALID', 'Configure tokens distintos com pelo menos 32 caracteres.');
  }
  const received = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
  const digest = value => createHash('sha256').update(value).digest();
  if (!timingSafeEqual(digest(received), digest(`Bearer ${token}`))) throw new AppError(401, 'UNAUTHORIZED', 'Token invalido.');
}

async function jsonBody(req, maxBytes) {
  if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
    throw new AppError(415, 'CONTENT_TYPE', 'Use Content-Type: application/json.');
  }
  if (Number(req.headers['content-length']) > maxBytes) throw new AppError(413, 'PAYLOAD_TOO_LARGE', 'Corpo excede o limite.');
  try {
    let text;
    // Vercel may supply an already-parsed request.body.
    if (req.body !== undefined) text = typeof req.body === 'string' ? req.body : Buffer.isBuffer(req.body) ? req.body.toString('utf8') : JSON.stringify(req.body);
    else {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += Buffer.byteLength(chunk);
        if (size > maxBytes) throw new AppError(413, 'PAYLOAD_TOO_LARGE', 'Corpo excede o limite.');
        chunks.push(Buffer.from(chunk));
      }
      text = Buffer.concat(chunks).toString('utf8');
    }
    if (Buffer.byteLength(text) > maxBytes) throw new AppError(413, 'PAYLOAD_TOO_LARGE', 'Corpo excede o limite.');
    const parsed = JSON.parse(text);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error();
    return parsed;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(400, 'JSON_INVALID', 'JSON invalido.');
  }
}

export function createHandler({ config: providedConfig, env = process.env, reader, cache, route, now = () => new Date() } = {}) {
  return async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const reply = (status, body) => { res.statusCode = status; res.end(JSON.stringify(body)); };
    try {
      const config = providedConfig || loadConfig();
      const requestTime = now();
      const url = new URL(req.url, 'http://localhost');
      const path = route || url.pathname;
      const routes = { '/health': 'GET', '/usuarios': 'GET', '/vendas': 'POST', '/internal/snapshot': 'PUT' };
      if (!Object.hasOwn(routes, path)) throw new AppError(404, 'NOT_FOUND', 'Rota inexistente.');
      if (req.method !== routes[path]) {
        res.setHeader('Allow', routes[path]);
        throw new AppError(405, 'METHOD_NOT_ALLOWED', 'Metodo nao permitido.');
      }
      const ingestion = path === '/internal/snapshot';
      authorize(req, env, ingestion ? 'SYNC_BEARER_TOKEN' : 'API_BEARER_TOKEN');
      if (path === '/health') return reply(200, { status: 'ok', mode: config.mode });
      const storage = cache || createCache(config, env);
      if (ingestion) {
        if (config.mode !== 2) throw new AppError(409, 'MODE_CONFLICT', 'Publicacao de cache disponivel somente no modo 2.');
        const body = await jsonBody(req, config.limits.maxPayloadBytes);
        const extractedMs = Date.parse(body.extractedAt);
        if (body.schemaVersion !== 1 || typeof body.extractedAt !== 'string' || !Number.isFinite(extractedMs) ||
            new Date(extractedMs).toISOString() !== body.extractedAt || extractedMs > requestTime.getTime() + 60000 ||
            requestTime.getTime() - extractedMs >= config.cache.ttlSeconds * 1000) {
          throw new AppError(422, 'SNAPSHOT_INVALID', 'Informe schemaVersion 1 e extractedAt ISO UTC recente.');
        }
        assertSnapshotWindow(body, config);
        const snapshot = { schemaVersion: 1, extractedAt: body.extractedAt, salesWindow: body.salesWindow,
          usuarios: normalizeRows('usuarios', body.usuarios, config.limits.maxRowsPerDataset),
          vendas: normalizeRows('vendas', body.vendas, config.limits.maxRowsPerDataset) };
        if (withinWindow(snapshot.vendas, snapshot.salesWindow).length !== snapshot.vendas.length) {
          throw new AppError(422, 'SALES_OUTSIDE_WINDOW', 'Snapshot contem vendas fora da janela configurada.');
        }
        if (Buffer.byteLength(JSON.stringify(snapshot)) > config.limits.maxPayloadBytes) throw new AppError(413, 'PAYLOAD_TOO_LARGE', 'Snapshot excede o limite apos formatacao.');
        await storage.write(snapshot);
        return reply(200, { ok: true, extractedAt: snapshot.extractedAt, usuarios: snapshot.usuarios.length, vendas: snapshot.vendas.length });
      }
      const dataset = path.slice(1);
      let filters = dataset === 'vendas' ? saleFilters(url, await jsonBody(req, config.limits.maxPayloadBytes), config.limits.maxProducts) : null;
      const window = filters ? salesWindow(config, requestTime, config.mode) : null;
      if (filters) {
        if (config.mode === 1) {
          filters = defaultDirectStart(filters, window);
          assertDirectStart(filters, config);
        }
        filters = intersectFilters(filters, window);
        if (filters.start > filters.end || filters.products.size === 0) return reply(200, { vendas: [] });
      }
      let raw;
      if (config.mode === 1) {
        const queryWindow = filters ? directQueryWindow(filters, window) : window;
        raw = await (reader || createFirebirdReader(config, env))(dataset, queryWindow);
      }
      else {
        const snapshot = await storage.read();
        if (window) assertCoverage(snapshot, window);
        raw = snapshot[dataset];
      }
      const rows = normalizeRows(dataset, raw, config.limits.maxRowsPerDataset);
      const result = { [dataset]: filters ? filterSales(rows, filters) : rows };
      if (Buffer.byteLength(JSON.stringify(result)) > config.limits.maxPayloadBytes) throw new AppError(413, 'RESPONSE_TOO_LARGE', 'Resultado excede o limite configurado.');
      reply(200, result);
    } catch (error) {
      if (error.status === 401) res.setHeader('WWW-Authenticate', 'Bearer');
      reply(error instanceof AppError ? error.status : 500, { error: error instanceof AppError ? error.code : 'INTERNAL_ERROR',
        message: error instanceof AppError ? error.message : 'Falha interna na integracao.' });
    }
  };
}
