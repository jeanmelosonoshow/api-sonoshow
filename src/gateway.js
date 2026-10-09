import { createHash, createHmac, randomUUID } from 'node:crypto';
import { AppError, requiredEnv, secureUrl } from './config.js';

export function createGatewayQuery(config, env = process.env, fetcher = fetch) {
  return async function queryGateway(sql, params = []) {
    const baseUrl = secureUrl(requiredEnv(env, 'FIREBIRD_GATEWAY_URL'), true);
    const tokenId = requiredEnv(env, 'FIREBIRD_GATEWAY_TOKEN_ID');
    const secret = requiredEnv(env, 'FIREBIRD_GATEWAY_HMAC_SECRET');
    const path = '/query';
    const body = JSON.stringify({ sql, params });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = randomUUID();
    const bodyHash = createHash('sha256').update(body, 'utf8').digest('hex');
    const canonical = [timestamp, nonce, 'POST', path, bodyHash].join('\n');
    const signature = createHmac('sha256', secret).update(canonical, 'utf8').digest('hex');

    let response;
    try {
      response = await fetcher(`${baseUrl}${path}`, {
        method: 'POST',
        redirect: 'error',
        headers: {
          Authorization: `Bearer ${tokenId}`,
          'Content-Type': 'application/json',
          'X-Timestamp': timestamp,
          'X-Nonce': nonce,
          'X-Signature': signature
        },
        body,
        signal: AbortSignal.timeout(config.limits.requestTimeoutMs)
      });
    } catch {
      throw new AppError(503, 'GATEWAY_UNAVAILABLE', 'Nao foi possivel acessar o Gateway Firebird.');
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new AppError(502, 'GATEWAY_INVALID_RESPONSE', 'O Gateway Firebird retornou uma resposta invalida.');
    }

    if (!response.ok) {
      if ([401, 403].includes(response.status)) {
        throw new AppError(502, 'GATEWAY_AUTH_FAILED', 'O Gateway Firebird recusou a credencial da integracao.');
      }
      if ([429, 503, 504].includes(response.status)) {
        throw new AppError(503, 'GATEWAY_UNAVAILABLE', 'O Gateway Firebird esta temporariamente indisponivel.');
      }
      throw new AppError(502, 'GATEWAY_QUERY_FAILED', 'O Gateway Firebird recusou a consulta ao ERP.');
    }

    if (payload.success !== true || !Array.isArray(payload.rows)) {
      throw new AppError(502, 'GATEWAY_INVALID_RESPONSE', 'O Gateway Firebird retornou uma resposta invalida.');
    }
    if (payload.truncated === true) {
      throw new AppError(502, 'GATEWAY_RESULT_TRUNCATED', 'O limite de linhas do Gateway Firebird precisa ser aumentado.');
    }

    return payload.rows;
  };
}
