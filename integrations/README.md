# SonoShow Gateway - homologacao de integracoes

Este diretorio contem o worker Windows de homologacao. Ele e independente da API
Vercel existente e do executavel de producao do SonoShowGateway.

Principios:

- conectores de origem e destinos sao plugaveis;
- segredos ficam em arquivo DPAPI separado da configuracao;
- toda execucao comeca em `dryRun: true` e `enabled: false`;
- cursores e idempotencia local usam SQLite;
- gravacoes Firebird usam uma unica transacao por lote;
- confirmacoes na API de origem ocorrem somente depois do commit;
- logs JSON registram contagens, hashes e resultado, nunca credenciais ou payloads.

Consulte `docs/HOMOLOGACAO-FLIT-FIREBIRD.md` antes de habilitar.

