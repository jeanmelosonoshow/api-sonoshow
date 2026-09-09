import { AppError, requiredEnv, secureUrl } from './config.js';

// One atomic snapshot prevents readers from observing half of a Windows upload.
// Refuse older extractions so overlapping scheduled executions cannot roll back data.
const publishScript = `
local old = redis.call('GET', KEYS[1])
if old then
  local previous = cjson.decode(old)
  local incoming = cjson.decode(ARGV[1])
  if previous.extractedAt >= incoming.extractedAt then return 0 end
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
return 1`;

export function createCache(config, env = process.env, fetcher = fetch) {
  async function command(args) {
    const url = secureUrl(requiredEnv(env, 'UPSTASH_REDIS_REST_URL'));
    const token = requiredEnv(env, 'UPSTASH_REDIS_REST_TOKEN');
    try {
      const response = await fetcher(url, {
        method: 'POST', redirect: 'error',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(args), signal: AbortSignal.timeout(config.limits.requestTimeoutMs)
      });
      if (!response.ok) throw new Error('Redis HTTP error');
      const body = await response.json();
      if (body.error || !Object.hasOwn(body, 'result')) throw new Error('Redis command error');
      return body.result;
    } catch {
      throw new AppError(503, 'CACHE_UNAVAILABLE', 'Nao foi possivel acessar o cache Upstash.');
    }
  }
  return {
    async read() {
      const raw = await command(['GET', config.cache.key]);
      if (raw === null) throw new AppError(503, 'CACHE_EMPTY', 'Cache ausente ou expirado. Execute a sincronizacao no Windows.');
      try {
        const snapshot = JSON.parse(raw);
        if (snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.usuarios) || !Array.isArray(snapshot.vendas) ||
            !Number.isFinite(Date.parse(snapshot.extractedAt)) || Date.parse(snapshot.extractedAt) > Date.now() + 60000 ||
            Date.now() - Date.parse(snapshot.extractedAt) >= config.cache.ttlSeconds * 1000) throw new Error();
        return snapshot;
      } catch {
        throw new AppError(503, 'CACHE_INVALID', 'Cache invalido ou desatualizado. Execute nova sincronizacao.');
      }
    },
    async write(snapshot) {
      const remainingTtl = Math.floor(config.cache.ttlSeconds - (Date.now() - Date.parse(snapshot.extractedAt)) / 1000);
      if (remainingTtl < 1) throw new AppError(422, 'SNAPSHOT_EXPIRED', 'Extracao antiga demais para publicar.');
      const result = await command(['EVAL', publishScript, 1, config.cache.key, JSON.stringify(snapshot), remainingTtl]);
      if (result !== 1) throw new AppError(409, 'SNAPSHOT_OLD', 'Ja existe uma extracao igual ou mais recente no cache.');
    }
  };
}
