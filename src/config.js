import { readFileSync } from 'node:fs';

export class AppError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function validateConfig(config) {
  const bad = () => { throw new AppError(503, 'CONFIG_INVALID', 'Configuracao da integracao invalida.'); };
  if (![1, 2].includes(config?.mode)) bad();
  const sales = config.sales;
  if (!sales || !Number.isSafeInteger(sales.lookbackDays) || sales.lookbackDays < 0 || sales.lookbackDays > 3650) bad();
  if (sales.initialDate !== null) {
    if (typeof sales.initialDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(sales.initialDate)) bad();
    const date = new Date(`${sales.initialDate}T00:00:00.000Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== sales.initialDate) bad();
  }
  if (typeof sales.timeZone !== 'string' || !sales.timeZone) bad();
  try { new Intl.DateTimeFormat('en', { timeZone: sales.timeZone }); } catch { bad(); }
  if (typeof config.cache?.key !== 'string' || !config.cache.key.trim()) bad();
  for (const value of [config.cache.ttlSeconds, config.limits?.maxPayloadBytes,
    config.limits?.maxRowsPerDataset, config.limits?.maxProducts, config.limits?.requestTimeoutMs]) {
    if (!Number.isSafeInteger(value) || value <= 0) bad();
  }
  if (config.limits.maxPayloadBytes > 3000000 || config.limits.requestTimeoutMs > 25000) bad();
  return config;
}

export function loadConfig() {
  return validateConfig(JSON.parse(readFileSync(new URL('../config/integration.json', import.meta.url), 'utf8')));
}

export function requiredEnv(env, name) {
  if (!env[name]?.trim()) throw new AppError(503, 'ENV_MISSING', `Configuracao ausente: ${name}.`);
  return env[name].trim();
}

export function secureUrl(value, allowLocal = false) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== 'https:' && !(allowLocal && url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) {
    throw new AppError(503, 'URL_INVALID', 'Use uma URL HTTPS sem credenciais ou parametros.');
  }
  return url.toString().replace(/\/$/, '');
}
