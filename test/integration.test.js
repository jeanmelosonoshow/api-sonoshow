import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHandler } from '../src/handler.js';
import { loadConfig, validateConfig, AppError } from '../src/config.js';
import { createCache } from '../src/cache.js';
import { readSql } from '../src/firebird.js';
import { salesWindow } from '../src/sales-window.js';

const testNow = new Date('2026-09-08T15:00:00.000Z');
function testConfig() {
  const config = loadConfig();
  config.sales.initialDate = '2026-01-01';
  return config;
}

const env = { API_BEARER_TOKEN: 'r'.repeat(40), SYNC_BEARER_TOKEN: 'w'.repeat(40) };
const usuario = { NOME: 'Teste', FILIAL: '111222000133', FILIAL_NOME: 'Loja', FILIAL_ESTADO: 'SP',
  FILIAL_CIDADE: 'Cidade', FILIAL_REGIONAL: 'Regional', DOCUMENTO: '100200304', CARGO: 'Gerente', RESPONSAVEL: null };
const sale = (id, date) => ({ filial_cnpj: '111222000133', pedido_id: '0001', nota_numero: '0002',
  pedido_data_venda: date, vendedor: '100200304', produto_id: id, produto_ean: `0789000000${id}`,
  produto_descricao: `Produto ${id}`, produto_qtd: 2, produto_valor: 15.5, produto_desconto: 0,
  fornecedor_cnpj: '98765432000110', fornecedor_razao: 'Fornecedor Teste Ltda', fornecedor_fantasia: 'Fornecedor Teste' });
const vendas = [sale('001', '2026-09-01 10:00:00'), sale('002', '2026-09-02 10:00:00'), sale('001', '2026-09-03 10:00:00')];
const snapshot = () => ({ schemaVersion: 3, extractedAt: new Date().toISOString(), salesWindow: salesWindow(testConfig(), testNow), usuarios: [usuario], vendas });

async function withApi(options, fn) {
  const server = createServer(createHandler({ env, config: testConfig(), now: () => testNow, ...options }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  async function call(path, { method = 'GET', body, token = env.API_BEARER_TOKEN, raw } = {}) {
    const response = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
    return { status: response.status, headers: response.headers, body: await response.json() };
  }
  try { await fn(call); } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

test('modos 1 e 2 preservam contrato, mascaras e filtros inclusivos', async () => {
  for (const mode of [1, 2]) {
    const config = { ...testConfig(), mode };
    let reads = 0;
    await withApi({ config,
      reader: async dataset => { assert.equal(mode, 1); reads++; return dataset === 'usuarios' ? [usuario] : vendas; },
      cache: { read: async () => { assert.equal(mode, 2); reads++; return snapshot(); } }
    }, async call => {
      const users = await call('/usuarios');
      assert.equal(users.status, 200);
      assert.equal(users.body.usuarios[0].documento, '001.002.003-04');
      assert.equal(users.body.usuarios[0].filial, '00.111.222/0001-33');
      assert.equal(users.body.usuarios[0].responsavel, null);
      assert.equal(users.headers.get('cache-control'), 'no-store');
      const result = await call('/vendas?date_start=2026-09-01%2010:00:00&date_end=2026-09-01%2010:00:00', { method: 'POST', body: { produtos: ['001'] } });
      assert.equal(result.status, 200);
      assert.equal(result.body.vendas.length, 1);
      assert.equal(result.body.vendas[0].pedido_id, '0001');
      assert.equal(result.body.vendas[0].produto_ean, '0789000000001');
      assert.equal(result.body.vendas[0].produto_descricao, 'Produto 001');
      assert.equal(result.body.vendas[0].fornecedor_cnpj, '98.765.432/0001-10');
      assert.equal(result.body.vendas[0].fornecedor_razao, 'Fornecedor Teste Ltda');
      assert.equal(result.body.vendas[0].fornecedor_fantasia, 'Fornecedor Teste');
      const empty = await call('/vendas', { method: 'POST', body: { produtos: [] } });
      assert.deepEqual(empty.body, { vendas: [] });
      assert.equal(reads, 2);
    });
  }
});

test('autenticacao separada, metodos e filtros rejeitados antes de consultar fonte', async () => {
  await withApi({ cache: { read: () => assert.fail('nao deve ler') } }, async call => {
    assert.equal((await call('/usuarios', { token: env.SYNC_BEARER_TOKEN })).status, 401);
    assert.equal((await call('/internal/snapshot', { method: 'PUT', body: snapshot() })).status, 401);
    assert.equal((await call('/usuarios', { method: 'POST', body: {} })).status, 405);
    assert.equal((await call('/vendas', { method: 'POST', raw: '{' })).status, 400);
    assert.equal((await call('/vendas', { method: 'POST', body: { produtos: [1] } })).status, 400);
    assert.equal((await call('/vendas?date_start=2026-02-30%2000:00:00', { method: 'POST', body: { produtos: ['001'] } })).status, 400);
    assert.equal((await call('/vendas?date_start=2026-09-03%2000:00:00&date_end=2026-09-01%2000:00:00', { method: 'POST', body: { produtos: ['001'] } })).status, 400);
  });
});

test('snapshot valido substitui ambos datasets; invalido preserva o anterior', async () => {
  let current = null;
  await withApi({ cache: { write: async value => { current = value; }, read: async () => current } }, async call => {
    const upload = body => call('/internal/snapshot', { method: 'PUT', token: env.SYNC_BEARER_TOKEN, body });
    const fresh = () => ({ ...snapshot(), extractedAt: testNow.toISOString() });
    assert.equal((await upload(fresh())).status, 200);
    assert.equal(current.usuarios[0].nome, 'Teste');
    const previous = current;
    assert.equal((await upload({ ...fresh(), vendas: [{ ...vendas[0], produto_valor: '15,50' }] })).status, 422);
    assert.equal(current, previous);
    assert.equal((await upload({ ...fresh(), vendas: [{ ...vendas[0], produto_ean: null }] })).status, 422);
    assert.equal(current, previous);
    assert.equal((await upload({ ...fresh(), schemaVersion: 1 })).status, 422);
    assert.equal(current, previous);
    assert.equal((await upload({ ...fresh(), usuarios: undefined })).status, 422);
    assert.equal((await upload({ ...snapshot(), extractedAt: '2020-01-01T00:00:00.000Z' })).status, 422);
    assert.equal((await call('/usuarios')).body.usuarios.length, 1);
  });
});

test('modo 1 recusa upload e nao faz fallback silencioso', async () => {
  await withApi({ config: { ...loadConfig(), mode: 1 }, reader: async () => { throw new AppError(503, 'FIREBIRD_UNAVAILABLE', 'Indisponivel'); },
    cache: { read: () => assert.fail('sem fallback'), write: () => assert.fail('sem escrita') }
  }, async call => {
    assert.equal((await call('/internal/snapshot', { method: 'PUT', token: env.SYNC_BEARER_TOKEN, body: snapshot() })).status, 409);
    assert.equal((await call('/usuarios')).status, 503);
  });
});

test('payload acima do limite e bloqueado sem atualizar cache', async () => {
  const config = loadConfig();
  config.limits.maxPayloadBytes = 50;
  await withApi({ config, cache: { write: () => assert.fail('nao pode escrever') } }, async call => {
    assert.equal((await call('/internal/snapshot', { method: 'PUT', token: env.SYNC_BEARER_TOKEN, body: snapshot() })).status, 413);
  });
});

test('Upstash usa GET e publicacao atomica com retencao de 90 dias, sem expor token em URL', async () => {
  const commands = [];
  const settings = { UPSTASH_REDIS_REST_URL: 'https://example.upstash.io', UPSTASH_REDIS_REST_TOKEN: 'test-only' };
  const cache = createCache(loadConfig(), settings, async (url, options) => {
    assert.equal(url, settings.UPSTASH_REDIS_REST_URL);
    assert.equal(options.headers.Authorization, 'Bearer test-only');
    const args = JSON.parse(options.body); commands.push(args);
    return Response.json({ result: args[0] === 'GET' ? JSON.stringify(snapshot()) : 1 });
  });
  await cache.write(snapshot());
  await cache.read();
  assert.equal(commands[0][0], 'EVAL');
  assert.match(commands[0][1], /previous.extractedAt >= incoming.extractedAt/);
  assert.ok(commands[0][5] > 0 && commands[0][5] <= 7776000);
  assert.equal(commands[1][0], 'GET');
});

test('cache vazio, corrompido, expirado e falha HTTP nao viram listas vazias', async () => {
  const settings = { UPSTASH_REDIS_REST_URL: 'https://example.upstash.io', UPSTASH_REDIS_REST_TOKEN: 'test-only' };
  for (const raw of [null, '{', JSON.stringify({ ...snapshot(), extractedAt: '2020-01-01T00:00:00.000Z' })]) {
    const cache = createCache(loadConfig(), settings, async () => Response.json({ result: raw }));
    await assert.rejects(cache.read(), error => error.status === 503);
  }
  const bad = createCache(loadConfig(), settings, async () => new Response('failed', { status: 500 }));
  await assert.rejects(bad.read(), error => error.code === 'CACHE_UNAVAILABLE');
  const older = createCache(loadConfig(), settings, async () => Response.json({ result: 0 }));
  await assert.rejects(older.write(snapshot()), error => error.status === 409);
});

test('cache retido fisicamente deixa de ser servido quando ultrapassa o frescor', async () => {
  const settings = { UPSTASH_REDIS_REST_URL: 'https://example.upstash.io', UPSTASH_REDIS_REST_TOKEN: 'test-only' };
  const stale = { ...snapshot(), extractedAt: new Date(Date.now() - 7200000).toISOString() };
  const cache = createCache(loadConfig(), settings, async () => Response.json({ result: JSON.stringify(stale) }));
  await assert.rejects(cache.read(), error => error.code === 'CACHE_INVALID');
});

test('configuracao rejeita modo invalido e os dois SELECTs carregam', () => {
  assert.throws(() => validateConfig({ ...loadConfig(), mode: 3 }), /invalida/);
  const invalidRetention = loadConfig();
  invalidRetention.cache.retentionSeconds = invalidRetention.cache.maxAgeSeconds - 1;
  assert.throws(() => validateConfig(invalidRetention), /invalida/);
  const usuariosSql = readSql('usuarios');
  assert.match(usuariosSql, /^WITH USR_DIRETORIA AS/i);
  assert.match(usuariosSql, /WHERE U\.DOCUMENTO IS NOT NULL/i);
  assert.match(usuariosSql, /TRIM\(CAST\(U\.DOCUMENTO AS VARCHAR\(20\)\)\) <> ''/i);
  assert.match(usuariosSql, /CHAR_LENGTH\([\s\S]+\) <= 11$/i);
  const vendasSql = readSql('vendas');
  assert.match(vendasSql, /^WITH VENDAS AS/i);
  assert.match(vendasSql, /:date_start/i);
  assert.match(vendasSql, /:date_end_exclusive/i);
  assert.match(vendasSql, /produto_ean/i);
  assert.match(vendasSql, /JOIN FORNECEDOR FO ON FO\.IDFORNECEDOR = P\.IDULTIMOFORNECEDOR/i);
  assert.match(vendasSql, /fornecedor_cnpj/i);
  assert.match(vendasSql, /fornecedor_fantasia/i);
  assert.match(vendasSql, /fornecedor_razao/i);
  assert.match(vendasSql, /produto_descricao/i);
  assert.match(vendasSql, /COALESCE\(NULLIF\(TRIM\(CAST\(L\.NUMERONF AS VARCHAR\(50\)\)\), ''\), '0'\) nota_numero/i);
});

test('vendas repetidas sao preservadas para o Club substituir o periodo', async () => {
  const repeated = sale('001', '2026-09-01 10:00:00');
  await withApi({ cache: { read: async () => ({ ...snapshot(), vendas: [repeated, { ...repeated }] }) } }, async call => {
    const result = await call('/vendas?date_start=2026-09-01%2000:00:00&date_end=2026-09-01%2023:59:59', {
      method: 'POST', body: { produtos: ['001'] }
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.vendas.length, 2);
  });
});

test('venda sem numero de nota usa zero enquanto a nota fiscal nao foi emitida', async () => {
  const withoutInvoice = { ...sale('001', '2026-09-01 10:00:00'), nota_numero: null };
  await withApi({ cache: { read: async () => ({ ...snapshot(), vendas: [withoutInvoice] }) } }, async call => {
    const result = await call('/vendas', { method: 'POST', body: { produtos: ['001'] } });
    assert.equal(result.status, 200);
    assert.equal(result.body.vendas[0].nota_numero, '0');
  });
});

test('rota Vercel preserva filtros mesmo com URL reescrita e body ja interpretado', async () => {
  const handler = createHandler({ config: testConfig(), env, now: () => testNow, route: '/vendas', cache: { read: async () => snapshot() } });
  let response;
  const res = { setHeader() {}, end(value) { response = JSON.parse(value); } };
  await handler({ method: 'POST', url: '/api/vendas?date_end=2026-09-01%2010:00:00',
    headers: { authorization: `Bearer ${env.API_BEARER_TOKEN}`, 'content-type': 'application/json' }, body: { produtos: ['001'] } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(response.vendas.length, 1);
});

test('tokens ausentes ou iguais nao liberam acesso; erro interno nao vaza detalhes', async () => {
  for (const badEnv of [{}, { API_BEARER_TOKEN: 'x'.repeat(40), SYNC_BEARER_TOKEN: 'x'.repeat(40) }]) {
    await withApi({ env: badEnv }, async call => assert.equal((await call('/usuarios')).status, 503));
  }
  await withApi({ cache: { read: () => { throw new Error('segredo-interno'); } } }, async call => {
    const result = await call('/usuarios');
    assert.equal(result.status, 500);
    assert.ok(!JSON.stringify(result.body).includes('segredo-interno'));
  });
});

test('vendas ficam bloqueadas sem data inicial e periodo externo retorna vazio sem ler fonte', async () => {
  const pending = loadConfig();
  pending.sales.initialDate = null;
  await withApi({ config: pending, cache: { read: () => assert.fail('nao deve ler sem data inicial') } }, async call => {
    const result = await call('/vendas', { method: 'POST', body: { produtos: ['001'] } });
    assert.equal(result.status, 503);
    assert.equal(result.body.error, 'INITIAL_DATE_PENDING');
  });
  await withApi({ cache: { read: () => assert.fail('nao deve ler periodo fora da janela') } }, async call => {
    const result = await call('/vendas?date_end=2020-01-01%2000:00:00', { method: 'POST', body: { produtos: ['001'] } });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { vendas: [] });
  });
});

test('modo 1 aceita historico desde initialDate e envia o periodo pedido ao Firebird', async () => {
  const config = testConfig();
  config.mode = 1;
  let receivedWindow;
  await withApi({ config, reader: async (dataset, window) => {
    assert.equal(dataset, 'vendas');
    receivedWindow = window;
    return [sale('001', '2026-02-01 12:00:00')];
  } }, async call => {
    const result = await call('/vendas?date_start=2026-02-01%2000:00:00&date_end=2026-02-01%2023:59:59', {
      method: 'POST', body: { produtos: ['001'] }
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.vendas.length, 1);
    assert.deepEqual(receivedWindow, {
      start: '2026-02-01 00:00:00', endExclusive: '2026-02-02 00:00:00', timeZone: 'America/Sao_Paulo'
    });
  });
});

test('modo 1 rejeita date_start anterior a initialDate sem consultar Firebird', async () => {
  const config = testConfig();
  config.mode = 1;
  await withApi({ config, reader: () => assert.fail('nao deve consultar') }, async call => {
    const result = await call('/vendas?date_start=2025-12-31%2023:59:59', { method: 'POST', body: { produtos: ['001'] } });
    assert.equal(result.status, 400);
    assert.equal(result.body.error, 'DATE_BEFORE_INITIAL');
  });
});

test('modo 1 sem datas consulta somente o dia atual', async () => {
  const config = testConfig();
  config.mode = 1;
  let receivedWindow;
  await withApi({ config, reader: async (dataset, window) => {
    receivedWindow = window;
    return [sale('001', '2026-09-08 12:00:00')];
  } }, async call => {
    const result = await call('/vendas', { method: 'POST', body: { produtos: ['001'] } });
    assert.equal(result.status, 200);
    assert.equal(result.body.vendas.length, 1);
    assert.deepEqual(receivedWindow, {
      start: '2026-09-08 00:00:00', endExclusive: '2026-09-09 00:00:00', timeZone: 'America/Sao_Paulo'
    });
  });
});

test('modo 1 sem date_start nao amplia consulta para um date_end antigo', async () => {
  const config = testConfig();
  config.mode = 1;
  await withApi({ config, reader: () => assert.fail('periodo vazio nao deve consultar') }, async call => {
    const result = await call('/vendas?date_end=2026-02-01%2023:59:59', { method: 'POST', body: { produtos: ['001'] } });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { vendas: [] });
  });
});
