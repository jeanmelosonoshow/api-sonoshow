# API Sonoshow — Club Moveleiro

API Node.js para disponibilizar usuarios e vendas do Firebird, diretamente ou pelo cache Upstash alimentado no Windows.

**Estado:** implementacao local com testes sinteticos. SELECTs de usuarios e vendas configurados; data inicial pendente. Nenhuma conexao com o Firebird/Upstash real, publicacao na Vercel ou transmissao de dados reais foi feita.

## Fluxo

O Club Moveleiro consulta a API que voce publica: `GET /usuarios` e `POST /vendas`, autenticados por Bearer Token. A documentacao fornecida nao descreve um endpoint externo para receber cadastros enviados por voce.

- Modo 1: Club Moveleiro → Vercel → Firebird → resposta.
- Modo 2: Windows → Firebird → Vercel → Upstash; Club Moveleiro → Vercel → Upstash → resposta.

Contrato conferido em https://www.clubmoveleiro.com.br/integracao em 08/09/2026.

## Escolher o modo

Arquivo `config/integration.json`:

```json
{
  "mode": 2,
  "sales": {
    "initialDate": null,
    "lookbackDays": 90,
    "timeZone": "America/Sao_Paulo"
  },
  "cache": {
    "key": "sonoshow:clubmoveleiro:v2:snapshot",
    "maxAgeSeconds": 3600,
    "retentionSeconds": 7776000
  },
  "limits": {
    "maxPayloadBytes": 3000000,
    "maxRowsPerDataset": 20000,
    "maxProducts": 2000,
    "requestTimeoutMs": 20000
  }
}
```

`mode: 1` usa somente Firebird; `mode: 2` usa somente Upstash. Nao ha troca automatica em caso de erro. Alterar o JSON exige novo deploy na Vercel. Mantenha a copia do Windows atualizada. Senhas ficam nas variaveis de ambiente, fora do JSON.

Antes de consultar vendas, substitua `null` em `sales.initialDate` pela data inicial no formato `YYYY-MM-DD`.

No modo 2, a janela disponibilizada no cache e calculada assim:

```text
inicio = maior valor entre sales.initialDate e (data atual - lookbackDays)
fim exclusivo = inicio do dia seguinte a data atual
```

Com `initialDate: "2026-01-01"` e data atual `2026-09-08`, por exemplo, o modo 2 usa `2026-06-10 00:00:00 <= venda < 2026-09-09 00:00:00`. Isso inclui o dia atual inteiro e evita problemas com fracoes de segundo. Se a data inicial for `2026-09-01`, o inicio sera `2026-09-01 00:00:00`.

No modo 1 nao se aplica `lookbackDays`. O periodo consultavel vai de `sales.initialDate` ate o dia atual. Se o Club informar `date_start` e `date_end`, esses limites sao enviados como parametros ao SELECT do Firebird, depois de validados. Sem `date_start`, a consulta comeca em `00:00:00` do dia atual; sem `date_start` e `date_end`, retorna somente o dia atual. Uma `date_start` explicita anterior a `sales.initialDate` retorna `DATE_BEFORE_INITIAL` e nao abre a consulta de vendas no banco. O calculo usa `America/Sao_Paulo` tanto no Windows quanto na Vercel.

Enquanto `initialDate` estiver `null`, `/vendas` e o sincronizador retornam `INITIAL_DATE_PENDING`. `/usuarios` continua disponivel. Uma data inicial futura produz uma lista de vendas vazia sem abrir conexao com o Firebird.

## Preparar o ambiente

Use Node.js 20.11 ou superior no Windows, preferencialmente uma versao LTS ainda suportada. Na Vercel, selecione uma versao suportada pelo projeto. Na pasta do repositorio:

```powershell
npm ci
Copy-Item .env.example .env
```

Nao sobrescreva um `.env` ja configurado. Preencha as variaveis conforme o ambiente:

| Variavel | Vercel modo 1 | Vercel modo 2 | Windows modo 2 |
|---|---|---|---|
| API_BEARER_TOKEN | Sim | Sim | Nao |
| SYNC_BEARER_TOKEN | Nao | Sim | Sim |
| UPSTASH_REDIS_REST_URL | Nao | Sim | Nao |
| UPSTASH_REDIS_REST_TOKEN | Nao | Sim | Nao |
| INTEGRATION_API_URL | Nao | Nao | Sim |
| FIREBIRD_HOST, PORT, DATABASE, USER, PASSWORD, ENCODING | Sim | Nao | Sim |

Use dois tokens diferentes com pelo menos 32 caracteres aleatorios cada. `SYNC_BEARER_TOKEN` deve ser igual na Vercel e no Windows. O Club Moveleiro recebe somente a URL de producao e `API_BEARER_TOKEN`. O token Upstash precisa permitir GET e EVAL/SET e fica apenas na Vercel. A URL do Upstash deve ser a REST/HTTPS, nao a redis://.

Use chave Redis diferente e dados de teste no ambiente de preview. `.env` esta excluido do Git. O script registra somente status e contagens, sem registros ou credenciais.

## Inserir os SELECTs

Os SELECTs estao em `sql/usuarios.sql` e `sql/vendas.sql`. Ainda falta executa-los contra o Firebird real e validar tipos, campos nulos, volume e plano de execucao.

Aliases de usuarios: `nome`, `filial`, `filial_nome`, `filial_estado`, `filial_cidade`, `filial_regional`, `documento`, `cargo`, `responsavel`.

Aliases de vendas: `filial_cnpj`, `pedido_id`, `nota_numero`, `pedido_data_venda`, `vendedor`, `produto_id`, `produto_ean`, `produto_descricao`, `produto_qtd`, `produto_valor`, `produto_desconto`, `fornecedor_cnpj`, `fornecedor_razao`, `fornecedor_fantasia`.

Quando a nota fiscal ainda não tiver sido emitida, `nota_numero` será enviado como texto com valor `"0"`.

O filtro de fornecedores fica em `config/sales-filter.json`. Preencha `supplierIds` com os IDs permitidos; uma lista vazia desativa a restricao. O filtro e inserido de forma parametrizada no marcador `/* SUPPLIER_FILTER */` do SELECT de vendas.

`fornecedor_cnpj` sera `null` quando o fornecedor nao tiver CNPJ cadastrado.

- Aliases em maiusculas tambem sao aceitos.
- CPF/CNPJ e identificadores devem vir como texto, preservando zeros iniciais. CPF/CNPJ podem vir com ou sem pontuacao; a API aplica a mascara. A validacao de formato nao verifica digitos verificadores.
- `responsavel` e obrigatorio e pode ser `NULL` no topo da hierarquia.
- Quantidade, valor e desconto devem ser numeros, nunca texto com virgula.
- `pedido_data_venda` deve vir como texto `YYYY-MM-DD HH:MM:SS`, no horario do ERP. Formate no SELECT; nao ha conversao automatica para UTC.
- `produto_ean` e uma extensao combinada diretamente com o Club Moveleiro. Ele e obrigatorio nesta integracao e sai como texto para preservar zeros iniciais. Um EAN nulo ou vazio interrompe a publicacao do snapshot.
- O SELECT de vendas deve conter os parametros `:date_start` e `:date_end_exclusive`, aplicados diretamente sobre a coluna nativa de data: `data_venda >= CAST(:date_start AS TIMESTAMP) AND data_venda < CAST(:date_end_exclusive AS TIMESTAMP)`. Os valores sao parametrizados; nao sao concatenados no SQL.
- Colunas extras nao sao expostas. Nenhuma rota aceita SQL do cliente. O leitor usa transacao somente leitura; configure tambem um usuario Firebird somente de consulta.

No modo 1, o Firebird recebe a intersecao entre o periodo solicitado e o intervalo de `sales.initialDate` ate hoje. Quando o inicio nao e informado, a API usa o inicio do dia atual para impedir uma consulta historica acidental. No modo 2, o Windows extrai somente a janela movel de 90 dias e grava seus limites junto com o snapshot. A Vercel recusa um snapshot com janela diferente da configuracao e, na virada do dia, retorna 503 ate o Windows publicar um snapshot que cubra o novo dia.

No modo 2, os parametros opcionais enviados pelo Club Moveleiro podem reduzir o periodo, mas nunca amplia-lo alem da janela em cache. No modo 1, podem consultar qualquer periodo cuja data inicial seja igual ou posterior a `sales.initialDate`, limitado ao dia atual. O filtro de produtos e aplicado depois da leitura nesta primeira versao; quando recebermos o SELECT e conhecermos o volume, ele podera ser levado ao Firebird de forma parametrizada.

## Windows: validar e sincronizar

Primeiro, consulte e valide sem enviar dados:

```powershell
npm run sync:check
```

Depois publique o snapshot:

```powershell
npm run sync
```

Alternativa para o Agendador de Tarefas:

```powershell
powershell.exe -NoProfile -File "C:\Users\Jean\Documents\Codex\API\api-sonoshow\scripts\sync-windows.ps1"
```

O wrapper usa a pasta correta independentemente da pasta inicial da tarefa. Configure, por exemplo, a cada 10 minutos para frescor maximo de 60 minutos, com **nao iniciar nova instancia** quando a anterior estiver em andamento. Nenhuma tarefa foi criada automaticamente. O usuario da tarefa precisa acessar Node.js, `.env` e Firebird. Mantenha o relogio do Windows sincronizado.

O script calcula a janela uma vez no inicio, consulta e valida ambos os conjuntos e envia os limites junto com os dados. Erro em uma consulta ou registro impede o envio inteiro. A publicacao Redis substitui usuarios e vendas atomicamente. Uploads iguais ou mais antigos retornam 409, preservando a extracao mais recente. Cada execucao substitui o conjunto completo: **nao envie somente deltas**. Listas vazias validas limpam o respectivo conjunto.

O snapshot fica retido no Redis por 90 dias (`retentionSeconds`), mas deixa de ser servido pela API apos 1 hora sem atualizacao (`maxAgeSeconds`). A retencao longa preserva o ultimo conjunto para diagnostico e recuperacao; a verificacao de frescor impede que uma falha silenciosa no Windows apresente dados antigos como atuais. O sincronizador deve continuar executando em intervalos menores que `maxAgeSeconds`.

Saida 0 indica sucesso; 1 indica erro. Nao ha agendamento automatico ou retry cego. Timeout de upload deixa o resultado incerto: o servidor pode ter gravado os dados antes da conexao falhar.

## Vercel

1. Envie este projeto ao GitHub quando estiver pronto e importe o repositorio na Vercel.
2. A raiz Vercel deve conter `package.json`. Se `api-sonoshow` ja e a raiz Git, deixe Root Directory vazio.
3. Use preset Other, sem comando de build ou diretorio de saida customizado. `api/` contem as Functions e `vercel.json` define as rotas.
4. Configure as variaveis conforme a tabela, publique e copie a URL de producao para `INTEGRATION_API_URL` no Windows.
5. No modo 2, execute a primeira sincronizacao antes de liberar o acesso ao consumidor. Verifique se a URL de producao e acessivel ao Club Moveleiro; o Bearer Token da aplicacao continua obrigatorio.

Modo 1 exige endereco Firebird alcancavel a partir da Vercel. IP privado, `127.0.0.1` e caminho local nao criam conectividade entre ambientes. `FIREBIRD_DATABASE` identifica o banco no servidor Firebird. A implementacao nao resolve sozinha firewall, roteamento ou compatibilidade da versao/autenticacao do banco.

## Endpoints

`GET /usuarios` retorna `{ "usuarios": [...] }`.

`POST /vendas` recebe `{ "produtos": ["001", "002"] }` e retorna `{ "vendas": [...] }`. Query parameters opcionais: `date_start` e `date_end`, ambos no formato `YYYY-MM-DD HH:MM:SS`, com limites inclusivos. No modo 1, a ausencia de `date_start` assume o inicio do dia atual, e uma data informada nao pode ser anterior a `sales.initialDate`. No modo 2, os parametros apenas estreitam a janela de 90 dias armazenada. Uma lista vazia de produtos retorna vendas vazias, nao todos os produtos. Cada item retornado inclui `produto_ean`.

`PUT /internal/snapshot` usa o token de sincronizacao e aceita `{ "schemaVersion": 3, "extractedAt": "<ISO UTC>", "usuarios": [...], "vendas": [...] }`. O script monta esse corpo automaticamente. Disponivel somente no modo 2.

`GET /health` exige o token de leitura e informa processo ativo e modo. Nao comprova acesso ao Firebird nem frescor do cache.

Teste local: `npm start`, acessivel somente em loopback. Para exercitar Upstash, configure uma base de teste e aponte `INTEGRATION_API_URL` para `http://127.0.0.1:3000`; HTTP e permitido apenas no localhost.

```powershell
$apiUrl = 'http://127.0.0.1:3000'
$apiHeaders = @{ Authorization = 'Bearer SEU_TOKEN_DE_LEITURA' }
Invoke-RestMethod "$apiUrl/usuarios" -Headers $apiHeaders
$query = 'date_start=2026-09-01%2000:00:00&date_end=2026-09-30%2023:59:59'
Invoke-RestMethod "$apiUrl/vendas?$query" -Method Post -Headers $apiHeaders -ContentType 'application/json' -Body '{"produtos":["001","002"]}'
```

## Limites e pendencias

- Snapshot inteiro limitado a 3.000.000 bytes; ate 20.000 linhas por conjunto e 2.000 produtos por filtro. Excesso gera erro, sem truncamento. O limite fica abaixo do payload maximo das Vercel Functions; o plano Upstash precisa comportar o comando. Lotes/paginacao nao estao implementados: volumes maiores exigem adaptacao antes de producao.
- Cada consulta no modo 2 carrega o snapshot completo de ate 90 dias. O frescor padrao e 1 hora; ajuste junto com a frequencia do script. Programe uma execucao logo apos a meia-noite para cobrir rapidamente a nova data.
- No modo 2, a janela movel permite disponibilizar e atualizar os ultimos `lookbackDays`, respeitando a data inicial. Alteracoes em vendas mais antigas ficam fora da consulta. No modo 1, o historico desde `sales.initialDate` permanece consultavel.
- Cache ausente, invalido ou vencido retorna 503, sem aparentar ausencia de usuarios/vendas.
- Nao ha controle de enviados nem deduplicacao na API. Conforme alinhado com o desenvolvedor do Club Moveleiro, eles apagam e reinserem os dados do periodo processado para garantir unicidade e incorporar atualizacoes. A API preserva as linhas produzidas pelo SELECT; o `GROUP BY` do proprio SELECT continua consolidando seus itens conforme a regra fornecida.
- A publicacao Redis e atomica; as duas consultas Firebird sao separadas e nao formam um snapshot transacional unico do ERP.
- Faltam SELECTs, versao do Firebird, volume/historico necessario, credenciais e teste ponta a ponta na Vercel.

## Testes

`npm test` usa o executor nativo do Node e dados sinteticos. Cobre modos, autenticacao, mascaras, filtros, uploads, expiracao e falhas. Nao usa credenciais nem altera servicos reais.

Referencias: [Club Moveleiro](https://www.clubmoveleiro.com.br/integracao), [Vercel Node.js](https://vercel.com/docs/functions/runtimes/node-js), [limites Vercel](https://vercel.com/docs/functions/limitations), [Upstash REST](https://upstash.com/docs/redis/features/restapi), [driver Firebird](https://github.com/hgourvest/node-firebird).
