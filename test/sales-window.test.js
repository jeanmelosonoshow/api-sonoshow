import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, validateConfig } from '../src/config.js';
import { salesWindow, withinWindow, intersectFilters, directQueryWindow, defaultDirectStart, assertDirectStart, assertSnapshotWindow, assertCoverage } from '../src/sales-window.js';
import { prepareQuery, createFirebirdReader } from '../src/firebird.js';

const config = (initialDate, mode = 2) => ({ ...loadConfig(), mode, sales: { initialDate, lookbackDays: 60, timeZone: 'America/Sao_Paulo' } });
const now = new Date('2026-09-08T15:00:00Z');

test('janela usa hoje menos 60 dias ou data inicial, escolhendo a maior', () => {
  assert.deepEqual(salesWindow(config('2026-01-01'), now), {
    start: '2026-07-10 00:00:00', endExclusive: '2026-09-09 00:00:00', timeZone: 'America/Sao_Paulo'
  });
  assert.equal(salesWindow(config('2026-09-01'), now).start, '2026-09-01 00:00:00');
  assert.equal(salesWindow(config('2026-07-10'), now).start, '2026-07-10 00:00:00');
});

test('modo 1 usa sales.initialDate sem aplicar limite movel de 60 dias', () => {
  const window = salesWindow(config('2020-01-01', 1), now);
  assert.deepEqual(window, {
    start: '2020-01-01 00:00:00', endExclusive: '2026-09-09 00:00:00', timeZone: 'America/Sao_Paulo'
  });
});

test('hoje usa fuso configurado e subtracao funciona em virada de ano e ano bissexto', () => {
  const c = config('2020-01-01');
  const midnight = salesWindow(c, new Date('2026-09-09T01:30:00Z'));
  assert.equal(midnight.endExclusive, '2026-09-09 00:00:00');
  assert.equal(salesWindow(c, new Date('2026-01-10T15:00:00Z')).start, '2025-11-11 00:00:00');
  assert.equal(salesWindow(c, new Date('2024-03-15T15:00:00Z')).start, '2024-01-15 00:00:00');
});

test('dia final completo incluido e dias fora da janela excluidos', () => {
  const dates = ['2026-07-09 23:59:59', '2026-07-10 00:00:00', '2026-09-08 23:59:59', '2026-09-09 00:00:00'];
  const rows = dates.map(pedido_data_venda => ({ pedido_data_venda }));
  assert.deepEqual(withinWindow(rows, salesWindow(config('2026-01-01'), now)).map(r => r.pedido_data_venda), dates.slice(1, 3));
});

test('datas opcionais do consumidor reduzem mas nao ampliam janela', () => {
  const window = salesWindow(config('2026-09-01'), now);
  const filters = intersectFilters({ start: '2020-01-01 00:00:00', end: '2030-01-01 00:00:00' }, window);
  assert.equal(filters.start, '2026-09-01 00:00:00');
  assert.equal(filters.end, '2026-09-08 23:59:59');
  const reduced = intersectFilters({ start: '2026-09-02 12:00:00', end: '2026-09-03 12:00:00' }, window);
  assert.equal(reduced.start, '2026-09-02 12:00:00');
  assert.equal(reduced.end, '2026-09-03 12:00:00');
});

test('modo 1 transforma o filtro aceito na janela parametrizada do Firebird', () => {
  const c = config('2020-01-01', 1);
  const window = salesWindow(c, now);
  const filters = intersectFilters({ start: '2021-04-05 10:00:00', end: '2021-04-05 10:00:00' }, window);
  assert.deepEqual(directQueryWindow(filters, window), {
    start: '2021-04-05 10:00:00', endExclusive: '2021-04-05 10:00:01', timeZone: 'America/Sao_Paulo'
  });
  assert.doesNotThrow(() => assertDirectStart({ start: '2020-01-01 00:00:00' }, c));
  assert.throws(() => assertDirectStart({ start: '2019-12-31 23:59:59' }, c), error => error.code === 'DATE_BEFORE_INITIAL');
});

test('modo 1 usa o inicio do dia atual quando date_start nao e informado', () => {
  const window = salesWindow(config('2020-01-01', 1), now);
  assert.deepEqual(defaultDirectStart({ products: new Set(), start: null, end: null }, window), {
    products: new Set(), start: '2026-09-08 00:00:00', end: null
  });
  const explicit = { start: '2024-02-01 00:00:00', end: null };
  assert.equal(defaultDirectStart(explicit, window), explicit);
});

test('data inicial futura nao abre conexao nem consulta banco', async () => {
  const c = config('2099-01-01');
  const rows = await createFirebirdReader(c, {})('vendas', salesWindow(c, now));
  assert.deepEqual(rows, []);
});

test('data inicial ausente, datas invalidas e fuso errado falham explicitamente', () => {
  assert.throws(() => salesWindow(config(null), now), error => error.code === 'INITIAL_DATE_PENDING');
  assert.throws(() => validateConfig(config('2026-02-30')), error => error.code === 'CONFIG_INVALID');
  assert.throws(() => validateConfig({ ...config('2026-01-01'), sales: { initialDate: '2026-01-01', lookbackDays: 60, timeZone: 'invalido' } }));
});

test('consulta Firebird recebe limites como parametros sem interpolar SQL', () => {
  const sql = 'SELECT * FROM VENDAS WHERE DATA >= CAST(:date_start AS TIMESTAMP) AND DATA < CAST(:date_end_exclusive AS TIMESTAMP)';
  const window = salesWindow(config('2026-09-01'), now);
  const query = prepareQuery('vendas', sql, window);
  assert.equal(query.sql, sql);
  assert.deepEqual(query.params, { date_start: '2026-09-01 00:00:00', date_end_exclusive: '2026-09-09 00:00:00' });
  assert.throws(() => prepareQuery('vendas', 'SELECT * FROM VENDAS', window), error => error.code === 'SQL_WINDOW_REQUIRED');
  assert.deepEqual(prepareQuery('usuarios', 'SELECT * FROM USUARIOS'), { sql: 'SELECT * FROM USUARIOS', params: [] });
});

test('snapshot identifica recorte; mudanca de dia ou configuracao exige nova cobertura', () => {
  const c = config('2026-09-01');
  const snapshot = { extractedAt: now.toISOString(), salesWindow: salesWindow(c, now) };
  assert.doesNotThrow(() => assertSnapshotWindow(snapshot, c));
  assert.throws(() => assertSnapshotWindow(snapshot, config('2026-09-02')), error => error.code === 'WINDOW_MISMATCH');
  assert.doesNotThrow(() => assertCoverage(snapshot, salesWindow(c, now)));
  assert.throws(() => assertCoverage(snapshot, salesWindow(c, new Date('2026-09-09T15:00:00Z'))), error => error.code === 'CACHE_WINDOW_STALE');
  assert.throws(() => assertCoverage({}, salesWindow(c, now)), error => error.code === 'CACHE_WINDOW_STALE');
});
