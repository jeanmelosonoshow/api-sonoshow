import { readFileSync } from 'node:fs';
import { AppError } from './config.js';
import { createGatewayQuery } from './gateway.js';
import { salesWindow } from './sales-window.js';

const MAX_GATEWAY_PARAMS = 1000;

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
  if (!config || !Array.isArray(config.supplierIds) || config.supplierIds.length > MAX_GATEWAY_PARAMS - 2 ||
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
  const values = { date_start: window.start, date_end_exclusive: window.endExclusive };
  const placeholders = supplierIds.map((id, index) => {
    const name = `supplier_id_${index}`;
    values[name] = id;
    return `:${name}`;
  });
  const clause = placeholders.length ? `AND FO.IDFORNECEDOR IN (${placeholders.join(', ')})` : '';
  const params = [];
  const positionalSql = sql.replace(marker, clause).replace(/:([a-z_][a-z0-9_]*)/gi, (_match, name) => {
    if (!Object.hasOwn(values, name)) {
      throw new AppError(503, 'SQL_PARAMETER_INVALID', `Parametro SQL nao reconhecido: ${name}.`);
    }
    params.push(values[name]);
    return '?';
  });
  if (params.length > MAX_GATEWAY_PARAMS) {
    throw new AppError(503, 'SQL_PARAMETER_LIMIT', 'A consulta excede o limite de parametros do Gateway.');
  }
  return { sql: positionalSql, params };
}

export function createFirebirdReader(config, env = process.env, fetcher = fetch) {
  return async function read(dataset, window) {
    if (dataset === 'vendas') {
      window ||= salesWindow(config);
      if (window.start >= window.endExclusive) return [];
    }
    const sql = readSql(dataset);
    const query = prepareQuery(dataset, sql, window);
    return createGatewayQuery(config, env, fetcher)(query.sql, query.params);
  };
}
