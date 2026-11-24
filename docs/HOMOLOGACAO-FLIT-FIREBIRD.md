# Teste controlado Flit para Firebird 3.0

## Isolamento da producao

O pacote gera `SonoShowGateway-Homologacao.exe`. Ele nao substitui, renomeia,
para, instala ou reconfigura o `SonoShowGateway.exe` existente. Usa:

- tarefa separada: `SonoShowGateway-Homologacao`;
- configuracao separada: `config/homologacao.json`;
- estado, credenciais e logs em `%PROGRAMDATA%\SonoShowGateway-Homologacao`;
- usuario Firebird proprio e configuracao de destino separada.

Para voltar ao original, encerre/desabilite somente a tarefa de homologacao. O
servico original nao e afetado.

## Contrato Flit confirmado

Conferido em 23/11/2026 na documentacao oficial
<https://api.flitapp.com.br/> (Swagger 1.2.0):

| Uso | Metodo e endpoint oficial |
|---|---|
| Gerar TerminalKey uma vez | `GET /autenticacao` |
| Empresas | `GET /empresas`, `GET /empresa/id/{id}`, `GET /empresa/cnpj/{cnpj}` |
| Jornadas | `POST /jornadas` |
| Excecoes incrementais | `POST /excecoes_pendentes` |
| Confirmar excecoes | `POST /confirmar_recebimento_excecoes` (maximo 500) |
| Marcacoes incrementais | `POST /marcacoes_pendentes` |
| Confirmar marcacoes | `POST /confirmar_recebimento_marcacoes` (maximo 500) |

As requisicoes autenticadas usam os cabecalhos `AccountKey`, `GlobalKey` e
`TerminalKey`. A TerminalKey e retornada apenas uma vez, por isso o comando
`auth-init` a salva com Windows DPAPI sem exibi-la.

A documentacao publica nao apresenta endpoints para cadastro completo de
colaboradores, situacao, admissao, desligamento, cargos ou departamentos. Esses
datasets existem na configuracao como extensoes previstas, mas ficam bloqueados.
Nao ha chamada presumida ou inventada. Para implementa-los, obter da Flit o
contrato privado/OpenAPI correspondente e exemplos anonimizados.

## Escopo autorizado no banco de producao

Esta versao esta travada para um unico colaborador: CPF `11447430794`.

- `target.environment` deve permanecer como `production`;
- `productionGuard.enabled` e obrigatorio;
- a lista aceita exatamente esse unico CPF;
- `/jornadas` recebe `cpf_colaborador` diretamente;
- jornadas, excecoes e marcacoes passam por um segundo filtro local;
- o destino Firebird rejeita qualquer lote que contenha outro CPF;
- empresas e cadastros sem identificacao individual ficam bloqueados;
- `acknowledgeSource` permanece `false` no primeiro teste, para nao consumir
  excecoes ou marcacoes pendentes na Flit.

O modo dry-run continua obrigatorio na primeira execucao contra as credenciais e
configuracoes reais. Ele nao abre transacao de escrita, nao confirma eventos e nao
avanca o cursor.

## Preparacao segura

1. Compile com `scripts/build-homologacao.ps1`.
2. Copie a pasta produzida para `C:\SonoShowGateway-Homologacao`.
3. Mantenha `enabled: false` e `dryRun: true`.
4. Preencha os CNPJs e `initialDate` em `config/homologacao.json`.
5. Execute `configure-secrets`; nenhuma credencial entra no JSON ou no Git.
6. Se a Flit ainda nao entregou TerminalKey, execute `auth-init` uma unica vez.
7. Execute `validate`.
8. Troque apenas `enabled` para `true` e rode `run-once`. Em dry-run nao ha
   gravacao Firebird, confirmacao Flit nem avanco do cursor.

Exemplo:

```powershell
.\SonoShowGateway-Homologacao.exe --config .\config\homologacao.json configure-secrets
.\SonoShowGateway-Homologacao.exe --config .\config\homologacao.json validate
.\SonoShowGateway-Homologacao.exe --config .\config\homologacao.json run-once
```

## Mapeamento Firebird pendente

Nao e seguro deduzir tabelas ou colunas do ERP. Antes de retirar o dry-run:

1. confirmar backup recente e janela de teste no banco de producao;
2. revisar e executar `homologacao-idempotencia.sql` no banco de producao;
3. criar usuario Firebird exclusivo com privilegios minimos;
4. preencher `config/flit-firebird.mapping.json` com SQL parametrizado e a ordem
   de campos em `params` (caminhos como `$.colaborador.documento`);
5. validar situacao, admissao, desligamento, jornada, faltas, atrasos e demais
   cadastros com o dicionario oficial do Firebird/SonoShow;
6. conferir que todos os SQLs usam o CPF/matricula do evento como parametro e
   nunca fazem UPDATE ou DELETE amplo;
7. trocar `dryRun` para `false` somente apos revisar o plano gerado.

Cada lote roda em uma transacao. O evento e verificado e gravado na tabela
`SSG_IDEMPOTENCIA` dentro da mesma transacao da alteracao. Em falha ocorre
rollback e a Flit nao recebe confirmacao. Jornadas usam janela com sobreposicao e
hash deterministico; excecoes e marcacoes usam o fluxo pendente/confirmacao da
Flit. O SQLite local mantem cursores e evita releituras normais, enquanto a tabela
Firebird protege contra repeticao depois de falha entre commit e atualizacao local.

## Logs e operacao

`%PROGRAMDATA%\SonoShowGateway-Homologacao\logs\audit.jsonl` registra somente
dataset, contagens, duracao, estado e identificadores tecnicos. Payloads e
credenciais nao sao registrados. Os arquivos giram automaticamente.

A instalacao opcional da tarefa usa `scripts/install-homologacao-task.ps1` e o
modo `IgnoreNew`, impedindo ciclos concorrentes. Para remover somente a tarefa de
homologacao use `scripts/uninstall-homologacao-task.ps1`.

