import { loadConfig, requiredEnv, secureUrl, AppError } from '../src/config.js';
import { createFirebirdReader } from '../src/firebird.js';
import { normalizeRows } from '../src/data.js';
import { salesWindow, withinWindow } from '../src/sales-window.js';

try {
  const config = loadConfig();
  if (config.mode !== 2) throw new AppError(409, 'MODE_CONFLICT', 'O script de cache exige mode 2 no JSON.');
  const checkOnly = process.argv.includes('--check');
  // Validate destination before querying the ERP. --check performs no upload.
  const url = checkOnly ? null : secureUrl(requiredEnv(process.env, 'INTEGRATION_API_URL'), true);
  const token = checkOnly ? null : requiredEnv(process.env, 'SYNC_BEARER_TOKEN');
  if (!checkOnly && token.length < 32) throw new AppError(503, 'TOKEN_CONFIG_INVALID', 'Token de sincronizacao deve ter pelo menos 32 caracteres.');
  const extractedAt = new Date().toISOString();
  const window = salesWindow(config, new Date(extractedAt));
  const read = createFirebirdReader(config);
  const snapshot = { schemaVersion: 2, extractedAt, salesWindow: window };
  for (const dataset of ['usuarios', 'vendas']) {
    snapshot[dataset] = normalizeRows(dataset, await read(dataset, window), config.limits.maxRowsPerDataset);
  }
  snapshot.vendas = withinWindow(snapshot.vendas, window);
  const body = JSON.stringify(snapshot);
  if (Buffer.byteLength(body) > config.limits.maxPayloadBytes) throw new AppError(413, 'PAYLOAD_TOO_LARGE', 'Dados excedem 3 MB. Ajuste o recorte SQL ou implemente publicacao em lotes antes de sincronizar.');
  if (!checkOnly) {
    const response = await fetch(`${url}/internal/snapshot`, {
      method: 'PUT', redirect: 'error',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body, signal: AbortSignal.timeout(config.limits.requestTimeoutMs + 5000)
    });
    if (!response.ok) throw new AppError(response.status, 'UPLOAD_FAILED', `Publicacao rejeitada: HTTP ${response.status}. O cache anterior nao foi confirmado como atualizado.`);
    const result = await response.json();
    if (result.ok !== true || result.extractedAt !== extractedAt) throw new AppError(502, 'UPLOAD_UNCONFIRMED', 'Servidor nao confirmou a extracao enviada.');
  }
  console.log(JSON.stringify({ status: checkOnly ? 'validado_sem_envio' : 'publicado', extractedAt,
    salesWindow: window, usuarios: snapshot.usuarios.length, vendas: snapshot.vendas.length, bytes: Buffer.byteLength(body) }));
} catch (error) {
  console.error(JSON.stringify({ status: 'erro', code: error instanceof AppError ? error.code : 'SYNC_FAILED',
    message: error instanceof AppError ? error.message : 'Falha na sincronizacao. Verifique rede e configuracao.' }));
  process.exitCode = 1;
}
