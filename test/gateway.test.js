import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { createGatewayQuery } from '../src/gateway.js';

const env = {
  FIREBIRD_GATEWAY_URL: 'https://gateway.test/',
  FIREBIRD_GATEWAY_TOKEN_ID: 'ssg_teste',
  FIREBIRD_GATEWAY_HMAC_SECRET: 'segredo-de-teste'
};

test('Gateway assina o corpo exato e devolve as linhas', async () => {
  let request;
  const query = createGatewayQuery(loadConfig(), env, async (url, options) => {
    request = { url, options };
    return Response.json({ success: true, rows: [{ OK: 1 }], row_count: 1, truncated: false });
  });

  assert.deepEqual(await query('SELECT ? FROM RDB$DATABASE', [1]), [{ OK: 1 }]);
  assert.equal(request.url, 'https://gateway.test/query');
  assert.equal(request.options.headers.Authorization, 'Bearer ssg_teste');
  const bodyHash = createHash('sha256').update(request.options.body, 'utf8').digest('hex');
  const canonical = [request.options.headers['X-Timestamp'], request.options.headers['X-Nonce'],
    'POST', '/query', bodyHash].join('\n');
  assert.equal(request.options.headers['X-Signature'],
    createHmac('sha256', env.FIREBIRD_GATEWAY_HMAC_SECRET).update(canonical, 'utf8').digest('hex'));
});

test('Gateway rejeita credencial recusada, configuração ausente e resultado truncado', async () => {
  const config = loadConfig();
  const unauthorized = createGatewayQuery(config, env, async () =>
    Response.json({ error: 'unauthorized' }, { status: 401 }));
  await assert.rejects(unauthorized('SELECT 1 FROM RDB$DATABASE'), error =>
    error.code === 'GATEWAY_AUTH_FAILED' && error.status === 502);

  const truncated = createGatewayQuery(config, env, async () =>
    Response.json({ success: true, rows: [], truncated: true }));
  await assert.rejects(truncated('SELECT 1 FROM RDB$DATABASE'), error =>
    error.code === 'GATEWAY_RESULT_TRUNCATED');

  const missing = createGatewayQuery(config, {}, async () => assert.fail('não deve chamar fetch'));
  await assert.rejects(missing('SELECT 1 FROM RDB$DATABASE'), error =>
    error.code === 'ENV_MISSING' && error.status === 503);
});
