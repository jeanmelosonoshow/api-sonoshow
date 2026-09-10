import { readFileSync } from 'node:fs';
import Firebird from 'node-firebird';
import { AppError, requiredEnv } from './config.js';
import { salesWindow } from './sales-window.js';

export function readSql(dataset) {
  if (!['usuarios', 'vendas'].includes(dataset)) throw new Error('Dataset invalido');
  const sql = readFileSync(new URL(`../sql/${dataset}.sql`, import.meta.url), 'utf8').replace(/^\s*--.*$/gm, '').trim();
  if (!sql) throw new AppError(503, 'SQL_PENDING', `SELECT de ${dataset} ainda nao configurado.`);
  // The SQL files are trusted repository configuration, never supplied by HTTP callers.
  if (!/^(SELECT|WITH)\b/i.test(sql)) throw new AppError(503, 'SQL_INVALID', 'Configure somente consultas de leitura.');
  return sql;
}

export function readSupplierIds() {
  let config;
  try {
    config = JSON.parse(readFileSync(new URL('../config/sales-filter.json', import.meta.url), 'utf8'));
  } catch {
    throw new AppError(503, 'FILTER_CONFIG_INVALID', 'Nao foi possivel ler config/sales-filter.json.');
  }
  if (!config || !Array.isArray(config.supplierIds) || config.supplierIds.length > 1000 ||
      config.supplierIds.some(id => !Number.isSafeInteger(id) || id <= 0)) {
    throw new AppError(503, 'FILTER_CONFIG_INVALID', 'supplierIds deve ser uma lista de inteiros positivos.');
  }
  return [...new Set(config.supplierIds)];
}

export function prepareQuery(dataset, sql, window, supplierIds = dataset === 'vendas' ? readSupplierIds() : []) {
  if (dataset !== 'vendas') return { sql, params: [] };
  if (!sql.includes(':date_start') || !sql.includes(':date_end_exclusive')) {
    throw new AppError(503, 'SQL_WINDOW_REQUIRED', 'SELECT de vendas deve filtrar por :date_start e :date_end_exclusive.');
  }
  const marker = '/* SUPPLIER_FILTER */';
  if (!sql.includes(marker)) {
    throw new AppError(503, 'SQL_FILTER_REQUIRED', `SELECT de vendas deve conter o marcador ${marker}.`);
  }
  const params = { date_start: window.start, date_end_exclusive: window.endExclusive };
  const placeholders = supplierIds.map((id, index) => {
    const name = `supplier_id_${index}`;
    params[name] = id;
    return `:${name}`;
  });
  const clause = placeholders.length ? `AND FO.IDFORNECEDOR IN (${placeholders.join(', ')})` : '';
  return { sql: sql.replace(marker, clause), params };
}

export function createFirebirdReader(config, env = process.env) {
  return async function read(dataset, window) {
    if (dataset === 'vendas') {
      window ||= salesWindow(config);
      if (window.start >= window.endExclusive) return [];
    }
    const sql = readSql(dataset);
    const query = prepareQuery(dataset, sql, window);
    const options = {
      host: requiredEnv(env, 'FIREBIRD_HOST'),
      port: Number(env.FIREBIRD_PORT || 3050),
      database: requiredEnv(env, 'FIREBIRD_DATABASE'),
      user: requiredEnv(env, 'FIREBIRD_USER'),
      password: requiredEnv(env, 'FIREBIRD_PASSWORD'),
      encoding: env.FIREBIRD_ENCODING || 'UTF8',
      namedPlaceholders: true,
      connectTimeout: config.limits.requestTimeoutMs
    };
    if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
      throw new AppError(503, 'CONFIG_INVALID', 'Porta Firebird invalida.');
    }
    const pool = Firebird.pool(1, options);
    try {
      return await pool.withConnection(async db => {
        const transaction = await db.transactionAsync(Firebird.ISOLATION_READ_COMMITTED_READ_ONLY);
        try {
          return await transaction.queryAsync(query.sql, query.params, { signal: AbortSignal.timeout(config.limits.requestTimeoutMs) });
        } finally {
          await transaction.rollbackAsync();
        }
      });
    } catch {
      throw new AppError(503, 'FIREBIRD_UNAVAILABLE', 'Falha ao consultar o Firebird. Verifique rede, credenciais, versao e SELECT.');
    } finally {
      await pool.destroyAsync();
    }
  };
}
