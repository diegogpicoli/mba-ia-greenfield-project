---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-11-05
scope_description: "Backend da Fase 03: fila de processamento, upload de até 10GB, uso do object storage S3 compatível (MinIO em Docker), execução do worker FFmpeg/ffprobe, URL única, streaming e download, ciclo de status do vídeo e tratamento de falhas."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — backend: recebe os módulos de vídeos, storage, fila e worker, além dos novos serviços do `compose.yaml`. Todos os TDs incidem aqui.
- `next-frontend/` — sem decisão aberta neste documento: o desafio é de backend e o frontend está fora do escopo desta fase. TD-02 e TD-08 são `Cross-layer` porque definem o contrato que um cliente HTTP precisa seguir, mas nenhum código de `next-frontend/` é produzido aqui.

_Decisões anteriores que restringem as opções:_

- `next-frontend-config-base/TD-03` (BFF estrito): o navegador nunca chama a API NestJS diretamente; todo tráfego para a API passa por Route Handlers do Next.js.
- `phase-02-auth/TD-02`: `JwtAuthGuard` global, com opt-out por `@Public()`.
- `phase-02-auth/TD-07`: erros de domínio no envelope `{ statusCode, error, message }`.
- `phase-01-configuracao-base/TD-02` e `TD-03`: variáveis validadas com Joi e configuração namespaced com `registerAs`.

---

## TD-01: Tecnologia da fila de processamento

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** O diagrama C4 (`docs/diagrams/software-arch.mermaid`) deixa a Message Queue como TBD, e a stack hoje só tem PostgreSQL. A fila transporta poucos jobs (`{ videoId }`), que duram de segundos a poucos minutos, então vazão não diferencia as opções. O que diferencia é retry com backoff, detecção de worker morto, integração com NestJS, custo de infraestrutura no Docker e compatibilidade com o projeto, que compila em CommonJS e testa com ts-jest. Pacotes publicados só em ESM não foram validados nessa combinação.

**Options:**

### Option A: BullMQ + Redis (`@nestjs/bullmq`)
- Novo serviço `redis` no Compose. A API publica com `BullModule.registerQueue`, e o worker consome com `@Processor` + `WorkerHost`.
- **Pros:** Módulo oficial do NestJS. Retry com backoff, `UnrecoverableError`, detecção de job travado e deduplicação por `jobId` já vêm prontos. É o padrão que a skill `nestjs-best-practices` (`micro-use-queues`) e o guia de testes do repo já usam como referência.
- **Cons:** Um container a mais, com estado. A documentação do BullMQ exige `maxmemory-policy noeviction` e recomenda AOF. Na v6, `ioredis` virou peer opcional e precisa ser instalado explicitamente.

### Option B: BullMQ com backend PostgreSQL
- O BullMQ 6 oferece `createPostgresBackend`, que grava a fila em um schema próprio do banco atual, criado com `runMigrations`. A API de filas e workers é a mesma da Option A.
- **Pros:** Nenhum container novo; o PostgreSQL já está na stack. A vazão menor (a documentação cita 1,5 a 2 vezes menos jobs/s) não pesa neste volume.
- **Cons:** `@nestjs/bullmq` (11.0.5 e 12.0.0) não expõe o parâmetro de backend, então `BullModule` e `@Processor` teriam de ser substituídos por providers manuais. A própria documentação trata o Redis como padrão e opção mais testada. As migrations da fila ficam fora do fluxo de migrations do TypeORM.

### Option C: pg-boss
- Fila sobre PostgreSQL, com schema próprio. Oferece retry com backoff, dead letter queue e heartbeat de worker.
- **Pros:** Nenhum container novo. Dead letter queue nativa.
- **Cons:** Sem módulo oficial do NestJS. A v12 é só ESM (`type: module`). A expiração padrão é de 15 minutos e o heartbeat vem desligado, então precisa de ajuste. Nada no repo usa essa biblioteca.

### Option D: RabbitMQ
- Broker AMQP em container próprio, usado via `@golevelup/nestjs-rabbitmq` ou `@nestjs/microservices`.
- **Pros:** Broker maduro, com roteamento rico e consumidores em qualquer linguagem.
- **Cons:** A infraestrutura mais pesada das quatro. Retry com backoff precisa ser montado à mão com dead letter exchange e TTL. Em quorum queues, o timeout padrão de ack é de 30 minutos. `@golevelup/nestjs-rabbitmq@9` exige `@nestjs/core ^11.1.24` e o projeto está em 11.1.16. O ganho de interoperabilidade não tem consumidor aqui.

**Recommendation:** **Option A (BullMQ + Redis)** — Entrega sem código próprio o que o TD-10 precisa (retry com backoff, `UnrecoverableError`, detecção de job travado, deduplicação por `jobId`) e já é a referência da skill e do guia de testes do repo; o custo real é um container com estado a mais, que as opções sobre PostgreSQL evitariam, mas elas perdem a integração oficial com NestJS sem ganho relevante neste volume. Versões: `bullmq@^6`, `ioredis` explícito e `@nestjs/bullmq@11.0.5`, a última da linha 11, em CommonJS e com peer de `bullmq ^6` e Nest 11 (a `12.0.0` é só ESM). Serviço `redis` com imagem `redis:8.8`, `maxmemory-policy noeviction` e AOF ligado. Chaves `REDIS_HOST=redis` e `REDIS_PORT=6379` no schema Joi, em `.env.example` e no Compose. Na implementação, atualizar o `TBD` da Message Queue na descrição do `CLAUDE.md`.

**Decision:** A (BullMQ + Redis)
**Libraries:** `bullmq@^6`, `ioredis`, `@nestjs/bullmq@11.0.5`

---

## TD-02: Estratégia de upload de até 10GB

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload"

**Context:** A seção 4 do plano exige que o upload não trave o sistema e possa ser retomado após falha de conexão. Um `PUT` único é limitado a 5 GB no S3, então fica descartado. O multipart aceita de 5 MiB a 5 GiB por parte, com até 10.000 partes. O BFF estrito agrava qualquer opção em que os bytes passem pela API, porque 10GB atravessariam o Next.js e depois o NestJS. É `Cross-layer` porque a sequência de chamadas é um contrato com o cliente; o frontend em si não é construído nesta fase.

**Options:**

### Option A: S3 Multipart com URLs pré-assinadas (cliente envia direto ao storage)
- `POST /videos` valida o tamanho, cria o rascunho e abre o `CreateMultipartUpload`. A API assina as partes sob demanda, o cliente faz `PUT` de cada parte no storage e chama `complete`, e a API fecha com `ListParts` + `CompleteMultipartUpload`. Retomar é perguntar à API quais partes faltam.
- **Impacto:** o backend só trata JSON e assina URLs; o cliente fatia o arquivo, controla concorrência e retry, e fala com dois destinos (BFF para JSON, storage para bytes).
- **Pros:** Nenhum byte passa pelo BFF nem pela API, que não gastam memória, disco ou conexões com o upload. Retomada por parte, com o estado guardado no próprio storage. Protocolo S3 padrão, sem servidor novo.
- **Cons:** Cliente mais complexo. O navegador precisa alcançar o storage, o que exige endpoint público e CORS (TD-03). URL pré-assinada não limita o tamanho, então o limite tem de ser conferido em `complete`. Diverge de `Rel(api, storage, "Uploads")` no diagrama e da descrição da API no `CLAUDE.md`, e esta última precisa ser atualizada.

### Option B: Protocolo tus (`@tus/server` + `@tus/s3-store`) dentro da API
- O servidor tus recebe `PATCH`es do cliente e os repassa ao storage como multipart. A retomada é por offset, com `tus-js-client` no navegador.
- **Impacto:** o backend passa a ficar no caminho dos dados; o cliente usa uma biblioteca pronta, mas ainda precisa alcançar o endpoint tus.
- **Pros:** Protocolo aberto e específico para retomada. O servidor vê todos os bytes, então `maxSize` é aplicado de fato. Hooks como `onUploadFinish` facilitam disparar o job.
- **Cons:** Os 10GB passam pela API, e pelo BFF também, a menos que se abra uma rota pública que viola o BFF estrito. O `StreamSplitter` grava chunks em disco, exigindo espaço temporário na API. O locker e o cache padrão só servem para uma instância. Os pacotes `@tus/*` são só ESM.

### Option C: `multipart/form-data` em streaming pela API (`@aws-sdk/lib-storage`)
- O cliente envia um formulário comum, e o controller encaminha o stream para o storage.
- **Impacto:** o backend carrega todo o tráfego; o cliente é o mais simples possível.
- **Pros:** Cliente trivial. Um único caminho de autenticação. Coincide com o diagrama atual. O limite de tamanho é aplicado no servidor.
- **Cons:** Queda de conexão recomeça do zero, o que contraria a seção 4 do plano. Os 10GB atravessam BFF e API, ocupando conexões por horas, e isso é o impacto de performance que a capability proíbe.

**Recommendation:** **Option A (S3 Multipart pré-assinado)** — É a única opção que atende ao mesmo tempo "sem impacto na performance" e a retomada da seção 4 sem violar o BFF estrito; perde-se simplicidade no cliente, que fica com o fatiamento e o retry. Parâmetros do contrato: a API define o tamanho de parte (16 MiB, ou 640 partes em 10 GiB) e assina em lotes com validade de 1h; o limite de 10 GiB (10.737.418.240 bytes) é checado no início pelo tamanho declarado e de novo em `complete` pela soma do `ListParts`, abortando o upload se exceder; `complete` é idempotente e usa os ETags do `ListParts`, então o cliente não depende de ler o header `ETag`; o `upload_id` fica só no banco. O `S3Client` usa `requestChecksumCalculation: 'WHEN_REQUIRED'`, porque o padrão do SDK v3 (`WHEN_SUPPORTED`) embute CRC32 nas URLs de `UploadPart` (comportamento confirmado no código do SDK, ainda não testado contra o MinIO). O MinIO não suporta a regra de lifecycle `AbortIncompleteMultipartUpload` e expira uploads incompletos por `MINIO_API_STALE_UPLOADS_EXPIRY` (padrão 24h); como 10 GiB a 1 Mbit/s levam cerca de 24h, o Compose deve subir esse prazo para 7 dias. Na implementação, atualizar a descrição da API no `CLAUDE.md`.

**Decision:** A (S3 Multipart pré-assinado)
**Libraries:** `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`

**Revisions:**
- 2026-11-05 — `complete` passa a receber do cliente a lista de `part_number` e `ETag`, e o `ListParts` fica só para verificar. Rationale: a AWS manda não montar o `complete` com a listagem, que omite parte em envio e poderia gerar vídeo truncado sem erro.
  A verificação confere partes 1..N, ETags e soma igual ao tamanho declarado; N é o teto do tamanho declarado dividido por 16 MiB, e o `ListParts` precisa ser paginado. Divergência responde erro sem abortar o upload, para o cliente reenviar, e exceder 10 GiB continua abortando. `CompleteMultipartUpload` usa a lista do cliente, e repetir o `complete` continua seguro. O cliente passa a ler o header `ETag`; em navegador isso depende de CORS, a conferir na fase que trouxer tela, já que a interface está fora desta fase. Esta revisão prevalece sobre o trecho da Recommendation que usa os ETags do `ListParts`.
- 2026-11-06 — Repetir o `complete` em `draft` com `NoSuchUpload` confere o objeto com `HeadObject` e segue se o tamanho bater; no JSON, o campo é `etag`. Rationale: cobre a queda entre fechar o multipart e gravar `processing`; o nome segue o snake_case do resto da API, e o header HTTP continua `ETag`.

---

## TD-03: Organização de buckets, chaves e endpoints do storage

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** O storage já está definido (S3 compatível, MinIO em Docker); aqui se decide como usá-lo. O arquivo original não pode vazar, porque rascunhos e vídeos unlisted (Fases 04 e 05) dependem disso. Thumbnails serão lidas em massa nas listagens das fases seguintes. Há também uma questão de rede: a assinatura de uma URL pré-assinada cobre o host, e o navegador não resolve o nome de serviço `minio` do Compose. Logo, a API não pode assinar URLs para o navegador usando o endpoint interno.

**Options:**

### Option A: Dois buckets, vídeos privados e thumbnails com leitura anônima
- `streamtube-videos` é privado, com chave `{videoId}/source`. `streamtube-thumbnails` tem política anônima só de `s3:GetObject`, com chave `{videoId}/thumbnail.jpg`.
- **Pros:** A política de cada tipo de arquivo fica isolada, e nenhum erro de prefixo expõe vídeo. Thumbnail ganha URL estável e cacheável, sem assinatura.
- **Cons:** Dois buckets para provisionar. A thumbnail de um rascunho ou vídeo unlisted é legível por quem tiver a URL (mitigado: sem listagem e com UUID na chave).

### Option B: Um bucket privado com prefixos, tudo por URL pré-assinada
- Chaves `videos/{videoId}/source` e `thumbnails/{videoId}/thumbnail.jpg`, com toda leitura assinada.
- **Pros:** Um bucket só e nenhum acesso anônimo. Regra de acesso uniforme.
- **Cons:** Cada thumbnail exige assinatura a cada listagem. Como a URL muda a cada resposta, o cache do navegador não ajuda nas grades das Fases 04 e 07.

### Option C: Um bucket com leitura anônima apenas no prefixo `thumbnails/*`
- Mesmas chaves da Option B, com política anônima restrita ao prefixo.
- **Pros:** Um bucket só e URL estável de thumbnail.
- **Cons:** A proteção dos vídeos passa a depender de uma condição de prefixo na política do mesmo bucket; um erro ali expõe os arquivos originais.

**Recommendation:** **Option A (dois buckets)** — Separa o risco dos vídeos da conveniência das thumbnails, ao custo de provisionar um bucket a mais e aceitar thumbnail de rascunho legível por quem tiver a URL. As chaves usam o UUID interno, nunca o ID público (TD-07) nem o nome do arquivo: assim não há texto do usuário na chave e reprocessar sobrescreve o mesmo objeto; o nome original fica no banco e só aparece no `Content-Disposition`. Não usar `mc anonymous set download`, que mapeia para a política `readonly` e inclui `s3:ListBucket`, expondo a lista de UUIDs de todos os vídeos. O provisionamento é idempotente via SDK (`CreateBucket` + `PutBucketPolicy` só com `s3:GetObject`), já que a imagem `minio/mc` também saiu do Docker Hub (TD-04). Endpoints: `S3_ENDPOINT=http://minio:9000` para as chamadas entre containers e `S3_PUBLIC_ENDPOINT=http://localhost:9000` apenas para assinar URLs destinadas ao navegador e montar URLs de thumbnail, sempre com `forcePathStyle: true`. Isso não viola a regra de rede do `CLAUDE.md`, porque nenhum container conecta nesse endereço: `getSignedUrl` calcula a assinatura sem acessar a rede. O worker assina com o endpoint interno. Chaves no schema Joi, em `.env.example` e no Compose: `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET_VIDEOS` e `S3_BUCKET_THUMBNAILS`. Os testes de integração usam o MinIO real do Compose, em vez do filesystem local descrito em `testing-guide-nestjs-project/references/external-systems.md`, porque multipart pré-assinado não existe nesse adaptador e o enunciado manda não mockar o que dá para testar com a infra do Compose.

**Decision:** A (dois buckets)
**Libraries:** `@aws-sdk/client-s3`

---

## TD-04: Origem da imagem Docker do MinIO

**Scope:** Repo-wide

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** MinIO continua sendo a escolha e não está em reavaliação; outros storages não foram pesquisados. O problema é que `image: minio/minio` não funciona mais. Verificado em 2026-11-05: `minio/minio` e `minio/mc` respondem 404 no Docker Hub; `quay.io/minio/minio` nega acesso anônimo (HTTP 401 no manifest, e `docker pull` falha), embora artigos recentes ainda citem essa origem; os binários em `dl.min.io` respondem 410 Gone; a release no GitHub não tem binários. O repositório `minio/minio` está arquivado, e o README informa que a edição Community é distribuída só como código-fonte. A última release, `RELEASE.2025-10-15T17-29-55Z`, contém a correção do CVE-2025-62506.

**Options:**

### Option A: Build local a partir do fonte oficial, em commit fixo
- Um Dockerfile multi-stage compila com `go install github.com/minio/minio@9e49d5e7a648` (última release) e copia o binário para uma imagem mínima. O Compose usa `build:` em vez de `image:`.
- **Pros:** É o MinIO de fato, pelo caminho que o próprio README indica. Não depende de nenhum registry de imagens nem de binário de terceiros. Inclui a correção do CVE-2025-62506.
- **Cons:** O primeiro `docker compose up` compila: 130 s medidos aqui, sem cache de módulos, além do pull de `golang:1.24-alpine`. Código congelado, sem correções futuras. Um Dockerfile a mais para manter.

### Option B: Fork mantido `pgsty/silo:RELEASE.2026-10-26T00-00-00Z`
- Imagem pronta do Silo, fork comunitário do MinIO, com as mesmas variáveis `MINIO_ROOT_USER` e `MINIO_ROOT_PASSWORD`.
- **Pros:** Pull imediato, amd64 e arm64, com tag fixa. Segue recebendo correções (última publicação em 2026-10-26).
- **Cons:** Não é o MinIO: o projeto se declara independente e sem vínculo com a MinIO, Inc., o que afasta a premissa da fase. Depende de um mantenedor comunitário. O nome antigo, `pgsty/minio`, está congelado em 2026-08-04.

### Option C: `bitnamilegacy/minio:2025.7.23-debian-12-r5`
- Empacotamento Bitnami do binário original do MinIO, em repositório legado.
- **Pros:** Pull imediato, tag fixa, binário original do MinIO.
- **Cons:** Congelado desde 2025-08-19, em versão anterior à correção do CVE-2025-62506. Tem convenções próprias da Bitnami. Repositório legado, sem garantia de permanência, risco que acaba de se concretizar com as imagens oficiais.

**Recommendation:** **Option A (build do fonte em commit fixo)** — Mantém a premissa de usar MinIO sem introduzir binário de terceiros e segue o caminho indicado pelo próprio projeto; o build foi testado em container descartável e gerou o binário em 130 s, sem cache de módulos. Perde-se tempo no primeiro `docker compose up` e correções futuras, então o código congelado serve para desenvolvimento e testes, e a Fase 07 (ambiente de produção) precisa reavaliar a origem do storage. Como a aplicação só conhece o contrato S3 (TD-03), trocar para a Option B depois exige mudar apenas o serviço no Compose, inclusive se o tempo de build atrapalhar quem for avaliar o projeto.

**Decision:** A (build do fonte em commit fixo)

---

## TD-05: Como o worker roda

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de processamento em segundo plano (filas)", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** O diagrama C4 mostra o Video Worker (FFmpeg) como container próprio, que consome a fila, lê e grava no storage e atualiza o banco. O enunciado pede object storage, fila e worker subindo via `docker compose` junto com o backend e reprova não tê-los reais no Compose, então o worker precisa consumir a fila sem nenhum `docker compose exec`. FFmpeg é pesado em CPU e não pode disputar recursos com a API. Depende do TD-01.

**Options:**

### Option A: Mesmo código, segundo entrypoint e serviço próprio no Compose
- `src/worker.ts` sobe com `NestFactory.createApplicationContext(WorkerModule)`, sem HTTP. O serviço `video-worker` usa uma imagem com FFmpeg e inicia esse entrypoint pelo próprio `command`; a imagem da API segue sem FFmpeg.
- **Pros:** Compartilha entidades, config, storage e migrations sem duplicar pacote. CPU e memória isoladas em outro container, que escala sozinho. Coincide com o diagrama.
- **Cons:** `AppModule` não pode importar o módulo do processor, ou a API também consumiria jobs. `nest-cli.json` tem `deleteOutDir: true` e API e worker compartilham o bind mount, então dois `nest start --watch` apagam o `dist/` um do outro; o worker precisa de `outDir` próprio. O `command` precisa resolver as dependências sozinho, porque hoje o `node_modules` só existe depois de um `docker compose exec`. O worker carrega dependências que só a API usa.

### Option B: Processor dentro do processo da API
- O `@Processor` roda no próprio `nestjs-api`, com FFmpeg na imagem da API. O processor sandboxed do BullMQ isolaria o processo, mas não o container.
- **Pros:** Nenhum serviço novo. O mais simples de subir.
- **Cons:** FFmpeg disputa CPU com o HTTP, contrariando "sem impacto na performance". O worker só consumiria com a API iniciada, e a API não inicia sozinha no Compose atual (`tail -f /dev/null`), o que não atende ao enunciado. Reiniciar a API derruba jobs em andamento. Contraria o diagrama. A documentação do NestJS avisa que não há injeção de dependência no processo forkado.

### Option C: Projeto separado (`video-worker/`), com `package.json` próprio
- Um terceiro subprojeto, com imagem e dependências independentes, ou o modo monorepo do Nest.
- **Pros:** Isolamento total de dependências e imagem. Fronteira de deploy explícita.
- **Cons:** Duplica entidade, config e storage, ou exige um pacote compartilhado que hoje não existe. Risco de divergência de schema. Custo desproporcional para um único tipo de job.

**Recommendation:** **Option A (mesmo código, container próprio)** — Isola o custo de CPU da API e segue o diagrama sem duplicar entidades nem config; o preço é a disciplina de não carregar o processor na API e um `outDir` próprio para o worker em desenvolvimento. O `WorkerModule` importa só TypeORM, storage e o processor, e `AppModule` nunca o importa. O FFmpeg roda como processo filho via `spawn`, então o event loop fica livre para renovar o lock do BullMQ (padrão de 30 s) e o processor sandboxed não é necessário. A imagem do worker acrescenta `ffmpeg` por `apt`, seguindo o `Dockerfile.dev` atual. O worker começa a consumir sozinho no `docker compose up`, sem `docker compose exec`: o `command` do serviço substitui o `tail -f /dev/null` do `Dockerfile.dev`, roda `npm install` em um `node_modules` próprio, num volume, para funcionar em clone novo sem disputar com o da API, e inicia `src/worker.ts`; ao subir o contexto, o `BullRegistrar` registra o `@Processor` no `onModuleInit` e o consumo começa. `depends_on` com healthcheck de `db`, `redis` e `minio` garante a ordem, e `restart: unless-stopped` traz o worker de volta após uma queda, quando o BullMQ recupera o job travado. A regra do `nestjs-project/CLAUDE.md` de não iniciar a aplicação sem pedido trata do servidor HTTP e não é afetada, porque o worker não abre porta.

**Decision:** A (mesmo código, container próprio)

**Revisions:**
- 2026-11-06 — `ffmpeg` entra no `Dockerfile.dev`, compartilhado por API e worker, e o `@QueueEventsListener` fica no processo do worker, junto do processor. Rationale: o `npm test` roda em `nestjs-api` e precisa do `ffmpeg`; a API continua sem chamá-lo, porque o processor não carrega nela.
  Esta revisão prevalece sobre o trecho da opção que diz que a imagem da API segue sem FFmpeg.
- 2026-11-06 — O `video-worker` recebe `env_file` com `.env.example` e `.env` opcional, e `start:worker` roda sem `--watch`. Rationale: um clone novo não tem `.env`, e a validação Joi exige as chaves. O `--watch` não percebe edição pelo bind mount e, com ele, o container não sairia para o `restart` agir; mudança no worker exige `docker compose restart video-worker`.

---

## TD-06: Extração de metadados e geração de thumbnail

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** A entrada tem até 10GB, e a fase pede só duração, metadados e um frame; nenhum bullet pede transcodificação. O arquivo vem de usuários, logo é entrada não confiável. Depende de TD-03 e TD-05.

**Options:**

### Option A: `spawn` de `ffprobe`/`ffmpeg`, lendo por URL pré-assinada
- `ffprobe -show_format -show_streams -of json <url>` e `ffmpeg -ss T -i <url> -frames:v 1 <saida>`. O FFmpeg usa HTTP Range e lê só os trechos necessários. O frame vai para um arquivo temporário e depois para o storage.
- **Pros:** Não baixa os 10GB nem exige disco proporcional. O tempo do job quase não depende do tamanho do arquivo. Nenhuma dependência npm.
- **Cons:** Depende da rede até o storage durante o job. Formatos sem índice podem forçar leitura maior. Saída e código de retorno são tratados à mão. A URL aparece nos argumentos do processo.

### Option B: `spawn` de `ffprobe`/`ffmpeg`, após baixar o arquivo inteiro
- O worker baixa o original para um volume temporário e processa localmente.
- **Pros:** O mais tolerante a formatos estranhos, com seek local. Fácil de depurar com o arquivo em mãos.
- **Cons:** Até 10GB de disco por job simultâneo. Tempo proporcional ao tamanho do arquivo. Limpeza do volume após queda do worker. Mais um volume no Compose.

### Option C: Wrapper `fluent-ffmpeg`, com qualquer uma das entradas
- API fluente em Node sobre os mesmos binários.
- **Pros:** Interface mais agradável e muitos exemplos publicados.
- **Cons:** Marcado como deprecated no npm e arquivado no GitHub desde 2025-05-22. Dependência sem manutenção em contato direto com entrada não confiável. Pouco ganho para dois comandos fixos.

**Recommendation:** **Option A (`spawn` com URL pré-assinada)** — O custo do job deixa de crescer com o arquivo, o que importa com 10GB, e não entra dependência sem manutenção; perde-se a tolerância do arquivo local, e o job passa a depender da rede até o storage. Entrada por stdin fica descartada, porque sem seek um MP4 com o índice no fim não abre. Como o padrão do FFmpeg libera todos os protocolos, os dois comandos usam `-protocol_whitelist http,https,tcp,tls`, impedindo que uma playlist enviada como vídeo leia arquivos locais; os argumentos vão em array, sem shell. O frame é tirado em torno de 10% da duração, com recuo para o primeiro frame em vídeos muito curtos. Ficam salvos duração, largura, altura, codecs, bitrate e container. A classificação de erros está no TD-10.

**Decision:** A (`spawn` com URL pré-assinada)
**Libraries:** `ffmpeg`

**Revisions:**
- 2026-11-06 — `ffprobe` e `ffmpeg` recebem, além de `-protocol_whitelist`, `-format_whitelist` com os formatos de vídeo comuns e `-rw_timeout` de 60 s. Rationale: o whitelist de protocolos libera `http`, e uma playlist com segmento `http://` fazia o worker requisitar o endereço antes de falhar; a lista de formatos barra a playlist antes de qualquer requisição. Sem o timeout, uma conexão parada prenderia o job, com o lock do BullMQ sendo renovado.

---

## TD-07: Estratégia de URL única

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** A seção 4 do plano pede uma URL curta e única, que nunca conflite com outro vídeo. Vídeos unlisted (Fases 04 e 05) só devem ser acessíveis pelo link, então o identificador não pode ser enumerável. A chave primária continua UUID, conforme `.claude/rules/nestjs-entities.md`; a decisão é sobre o identificador público.

**Options:**

### Option A: 8 bytes aleatórios em base64url, com `UNIQUE` e retry
- `randomBytes(8).toString('base64url')` gera 11 caracteres, em coluna `varchar(11) UNIQUE`. Uma colisão no insert (`23505`) gera novo valor e nova tentativa.
- **Pros:** Sem dependência nova. 64 bits imprevisíveis. O "nunca conflita" é garantido pela constraint, não por probabilidade. Mesmo mecanismo já usado em `channels.service.ts` (retry em `PG_UNIQUE_VIOLATION`) e `nickname.util.ts` (`randomBytes`).
- **Cons:** IDs sensíveis a maiúsculas, com `-` e `_`. Exige o laço de retry, ainda que mínimo.

### Option B: `nanoid`
- Mesma ideia, com a biblioteca gerando o valor e alfabeto configurável. Também precisa de `UNIQUE` e retry.
- **Pros:** Biblioteca consolidada. Alfabeto e tamanho customizáveis, por exemplo sem caracteres ambíguos.
- **Cons:** Dependência para uma linha de código. A v6 é só ESM, combinação não validada com ts-jest neste projeto.

### Option C: Sqids sobre sequência do banco
- Codifica um contador sequencial em uma string curta.
- **Pros:** Sem colisão por construção, logo sem retry. IDs muito curtos no início.
- **Cons:** Reversível: a FAQ do Sqids diz que os IDs podem ser decodificados de volta em números e que a técnica não serve para dados sensíveis. Sequência enumerável expõe vídeos unlisted e revela o total de vídeos. Exige coluna de sequência.

### Option D: UUID da chave primária na URL
- Usa diretamente o `id`, sem coluna nova.
- **Pros:** Nenhuma coluna nem código de geração. Unicidade já garantida.
- **Cons:** Com 36 caracteres, não atende à "URL curta" do plano.

**Recommendation:** **Option A (base64url aleatório com `UNIQUE`)** — Atende a "curta", "nunca conflita" e "não enumerável" sem dependência nova, reaproveitando o padrão de retry que o repo já tem; o que se perde é o alfabeto customizável do `nanoid`, sem efeito prático aqui. O identificador é gerado no pré-cadastro (TD-02), para existir desde o rascunho, e é imutável. O storage nunca usa esse valor (TD-03), então a URL pública fica desacoplada das chaves.

**Decision:** A (base64url aleatório com `UNIQUE`)

---

## TD-08: Estratégia de streaming e download

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** O diagrama C4 já mostra o frontend fazendo streaming direto do storage. O S3 atende HTTP Range nativamente, e o `<video>` do navegador usa Range para tocar e buscar sem baixar tudo. O S3 confere a validade da URL no início de cada requisição: um download em andamento continua após expirar, mas um novo Range depois disso falha. É `Cross-layer` porque define o que o player recebe. Depende de TD-02 e TD-03.

**Options:**

### Option A: URL pré-assinada de leitura, direto ao storage (progressivo por HTTP Range)
- A API devolve `{ url, expiresAt }`, e o cliente usa a URL no `<video>`. O download usa o mesmo mecanismo, com `ResponseContentDisposition: attachment`.
- **Impacto:** o backend só assina; o cliente recebe uma URL e pede outra quando ela expira.
- **Pros:** Nenhum byte de vídeo passa por BFF ou API. Range e busca nativos, sem pipeline extra. Um só mecanismo para assistir e baixar. Coincide com o diagrama.
- **Cons:** Só toca o que o navegador decodifica, em qualidade única. A URL dá acesso a quem a tiver até expirar. Uma busca após a expiração falha com 403 e exige nova URL.

### Option B: Proxy pela API (`StreamableFile` repassando Range)
- O controller lê do storage e devolve o stream, repassando os headers de Range.
- **Impacto:** todo o tráfego de vídeo passa pelo backend e pelo BFF; o cliente tem uma URL estável.
- **Pros:** Autorização a cada requisição. Storage totalmente oculto. URL que não expira.
- **Cons:** Cada byte atravessa Next.js e NestJS, o mesmo problema que o TD-02 evita. Range e 206 são reimplementados à mão. Conexões da API ficam presas durante a reprodução.

### Option C: HLS adaptativo
- O worker transcodifica em várias resoluções e segmentos, e o player usa `hls.js`.
- **Impacto:** o worker ganha um pipeline de transcodificação; o cliente precisa de um player HLS.
- **Pros:** Qualidade adaptativa e reprodução garantida em qualquer navegador, porque todo vídeo é normalizado. Segmentos curtos favorecem cache.
- **Cons:** Exige transcodificação, que não está em nenhum bullet da fase. Multiplica CPU e armazenamento. Atrasa muito o vídeo ficar pronto.

**Recommendation:** **Option A (URL pré-assinada com HTTP Range)** — Entrega streaming e download sem colocar bytes de vídeo no BFF ou na API e sem transcodificação fora do escopo; perde-se qualidade adaptativa e a garantia de reprodução em qualquer navegador. A URL vale 6h, e o cliente pede outra ao receber 403. O `Content-Type` é gravado no `CreateMultipartUpload`, e o nome original entra só no `Content-Disposition` do download. Só vídeos `ready` recebem URL. Não há publicação nesta fase e o acesso anônimo é bullet da Fase 05, então a API entrega URL apenas ao dono autenticado, e a Fase 05 abre a rota.

**Decision:** A (URL pré-assinada com HTTP Range)
**Libraries:** `@aws-sdk/s3-request-presigner`

**Revisions:**
- 2026-11-06 — O campo da resposta se chama `expires_at`, no lugar do `expiresAt` da opção. Rationale: snake_case, como o resto da API.

---

## TD-09: Ciclo de status do vídeo

**Scope:** Backend

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** O enunciado pede o ciclo de status rascunho → processando → pronto/erro refletido no banco, em uma coluna `status` da tabela de vídeos, e o plano define que o vídeo já é rascunho ao iniciar o upload. Publicação é assunto da Fase 04 e não é antecipada aqui.

**Options:**

### Option A: Dois eixos no banco (`processing_status` e `publication_status`)
- `processing_status` segue `uploading → processing → ready | failed`. `publication_status` nasce `draft`, e a Fase 04 acrescenta `published`.
- **Pros:** Fiel ao plano, com rascunho desde o início. A Fase 04 evolui a publicação sem tocar no pipeline. O worker só escreve o eixo técnico, o que preserva a responsabilidade única.
- **Cons:** Não é o ciclo do enunciado, que descreve um status só. Adianta para esta fase o eixo de publicação, que é da Fase 04. Duas colunas, e uma combinação inválida (publicado sem estar pronto) precisaria ser barrada por regra.

### Option B: Enum único e linear
- `uploading → processing → draft → published`, mais `failed`.
- **Pros:** Uma coluna, sem combinação inválida e com consultas triviais.
- **Cons:** Não é o ciclo do enunciado e já inclui `published`, que é da Fase 04. O vídeo só seria `draft` depois de processar, contrariando o bullet do plano. Mistura responsabilidades do worker e do usuário.

### Option C: Estado do job como fonte de verdade
- O banco guarda só o rascunho, e a API consulta `job.getState()` na fila.
- **Pros:** Sem coluna para sincronizar. Progresso do job disponível de graça.
- **Cons:** O enunciado pede o ciclo refletido no banco. Jobs somem pela política de retenção. Uma listagem exige N consultas ao Redis. A leitura da API passa a depender do Redis. Não há estado antes de o job existir.

### Option D: Coluna única `status` no ciclo do enunciado
- `status` segue `draft` (rascunho) → `processing` (processando) → `ready` (pronto) | `error` (erro). Nasce `draft` no `POST /videos`, ao iniciar o upload, e fica assim enquanto as partes são enviadas.
- **Pros:** É o ciclo que o enunciado pede, refletido no banco. Cumpre o bullet de rascunho ao iniciar o upload. Uma coluna só, sem combinação inválida.
- **Cons:** `draft` não distingue upload em andamento de upload abandonado. A Fase 04 terá de definir como representar a publicação, o que pode exigir migration.

**Recommendation:** **Option D (coluna única no ciclo do enunciado)** — É o ciclo que o enunciado pede, nasce rascunho como o plano exige e não antecipa nada da Fase 04; não há impedimento concreto, porque a retomada do upload usa o `ListParts` e não o status, e o custo é a Fase 04 precisar definir depois como representar a publicação. Os valores ficam em inglês, como os demais enums do código. Transições: `POST /videos` cria com `draft`; `complete` fecha o multipart, enfileira com `jobId = videoId` e só então grava `processing`, de modo que repetir a chamada é seguro; o worker grava `ready` junto com metadados e thumbnail, ou `error` (TD-10). A API expõe `status` no recurso do vídeo, para consulta por polling.

**Decision:** D (coluna única no ciclo do enunciado)

**Revisions:**
- 2026-11-06 — `VideosController` usa `@SkipThrottle()`, conforme `phase-02-auth/TD-08`. Rationale: com o `ThrottlerGuard` global de 10 requisições por minuto, o polling de `status` receberia `429`.

---

## TD-10: O que acontece em caso de falha no processamento

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** Há falhas transitórias (storage, banco ou rede indisponíveis, queda do worker) e permanentes (arquivo corrompido, sem stream de vídeo). O usuário pode ter acabado de enviar 10GB, então descartar o arquivo custa caro. O BullMQ entrega jobs ao menos uma vez e recupera um job travado uma vez por padrão (`maxStalledCount`), então o job precisa ser idempotente. Depende de TD-01 e TD-09.

**Options:**

### Option A: Retries limitados, classificação de erro e status `error` preservando o original
- Três tentativas com backoff exponencial. Falha permanente lança `UnrecoverableError` e não repete. Ao fim, o vídeo vai para `error` com um `failure_code`, e o arquivo original é mantido.
- **Pros:** Falhas transitórias se resolvem sozinhas. Arquivo inválido falha rápido, sem gastar tentativas. Uma falha de infraestrutura não destrói um upload de 10GB. O código de falha já serve ao painel da Fase 04.
- **Cons:** Vídeos em `error` seguem ocupando storage. Exige classificar erros. Uma indisponibilidade mais longa que os retries ainda termina em `error`.

### Option B: Sem retry, com status `error` na primeira falha
- Qualquer falha leva a `error`, e o usuário envia o arquivo de novo.
- **Pros:** O mais simples, sem classificação de erro.
- **Cons:** Uma instabilidade momentânea força reenviar até 10GB. Ignora um recurso pronto da fila. A queda do worker ainda passa pela recuperação de job travado, então não elimina esse caso.

### Option C: Retries e remoção automática do original ao falhar
- Igual à Option A, mas a falha terminal apaga o arquivo do storage.
- **Pros:** Não acumula arquivos órfãos, o que ajuda no custo de armazenamento citado na seção 4 do plano.
- **Cons:** Irreversível: um incidente de infraestrutura ou um bug no worker destrói uploads dos usuários, e não há como reprocessar depois.

**Recommendation:** **Option A (retries limitados, preservando o original)** — Absorve falhas transitórias sem pedir novo upload de 10GB e falha rápido quando o arquivo é o problema; perde-se espaço em storage enquanto vídeos falhos existirem. Backoff exponencial com semente de 30 s. Falha permanente: `ffprobe` rejeita o arquivo ou não há stream de vídeo. O job é idempotente, porque reescreve a mesma chave de thumbnail e a mesma linha no banco. O status `error` é gravado por `QueueEvents` (`@QueueEventsListener`), cujo evento `failed` sempre traz o `jobId`, igual ao `videoId`; o evento `failed` do `Worker` não basta, porque o `job` pode vir indefinido quando um job travado estoura o limite. Reprocessar por endpoint não está em nenhum bullet da fase, então não entra aqui; preservar o original deixa essa porta aberta.

**Decision:** A (retries limitados, preservando o original)
**Libraries:** `bullmq`

**Revisions:**
- 2026-11-05 — O `failure_code` da Option A não entra, e a falha fica registrada só pelo status `error`. Rationale: o enunciado não o pede e manda não inventar requisitos, e a justificativa era o painel da Fase 04.
- 2026-11-06 — O listener usa `lastEventId: '0-0'` para reler os eventos retidos ao subir, e grava `error` só `WHERE id = jobId AND status IN ('draft', 'processing')`. Rationale: um `failed` emitido com o processo fora do ar não se perde, e reler é seguro porque o `jobId` é único por vídeo e não há reprocessamento nesta fase; o `draft` entra porque o worker pode falhar antes de a API gravar `processing`.

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Tecnologia da fila de processamento | A: BullMQ + Redis (`@nestjs/bullmq`) | A |
| TD-02 | Cross-layer | Estratégia de upload de até 10GB | A: S3 Multipart com URLs pré-assinadas | A |
| TD-03 | Backend | Organização de buckets, chaves e endpoints | A: Dois buckets, vídeos privados e thumbnails com leitura anônima | A |
| TD-04 | Repo-wide | Origem da imagem Docker do MinIO | A: Build local do fonte oficial, em commit fixo | A |
| TD-05 | Backend | Como o worker roda | A: Mesmo código, segundo entrypoint e container próprio | A |
| TD-06 | Backend | Extração de metadados e thumbnail | A: `spawn` de `ffprobe`/`ffmpeg` por URL pré-assinada | A |
| TD-07 | Backend | Estratégia de URL única | A: 8 bytes aleatórios em base64url, com `UNIQUE` e retry | A |
| TD-08 | Cross-layer | Estratégia de streaming e download | A: URL pré-assinada com HTTP Range | A |
| TD-09 | Backend | Ciclo de status do vídeo | D: Coluna única `status` (`draft` → `processing` → `ready` ou `error`) | D |
| TD-10 | Backend | Falha no processamento | A: Retries limitados, preservando o original | A |

## Fontes

Versões e disponibilidade conferidas em 2026-11-05 no registry do npm, no Docker Hub, no Quay e na API do GitHub.

- S3: [limites de multipart](https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html), [validade de URLs pré-assinadas](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html)
- AWS SDK v3: [`requestChecksumCalculation`](https://github.com/aws/aws-sdk-js-v3/blob/main/supplemental-docs/CLIENTS.md), [middleware de checksums](https://github.com/aws/aws-sdk-js-v3/blob/main/packages-internal/checksums/src/submodules/flexible-checksums/flexibleChecksumsMiddleware.ts)
- BullMQ: [jobs travados](https://docs.bullmq.io/bull/important-notes), [retry](https://docs.bullmq.io/guide/retrying-failing-jobs), [`UnrecoverableError`](https://docs.bullmq.io/patterns/stop-retrying-jobs), [produção](https://docs.bullmq.io/guide/going-to-production), [backend PostgreSQL](https://docs.bullmq.io/guide/postgresql), [evento `failed` do Worker](https://docs.bullmq.io/api/interfaces/v6.WorkerListener.html), [evento `failed` de QueueEvents](https://docs.bullmq.io/api/interfaces/v6.QueueEventsListener.html)
- NestJS: [filas](https://github.com/nestjs/docs.nestjs.com/blob/11.0.0/content/techniques/queues.md), [contexto de aplicação](https://github.com/nestjs/docs.nestjs.com/blob/11.0.0/content/application-context.md)
- pg-boss: [expiração e retry](https://github.com/timgit/pg-boss/blob/master/docs/api/jobs.md), [heartbeat](https://github.com/timgit/pg-boss/blob/master/docs/api/queues.md)
- RabbitMQ: [timeout de ack](https://www.rabbitmq.com/docs/consumers)
- tus: [S3Store](https://github.com/tus/tus-node-server/blob/main/packages/s3-store/README.md), [locker](https://github.com/tus/tus-node-server/blob/main/packages/server/README.md)
- MinIO: [README e distribuição só por fonte](https://github.com/minio/minio), [variáveis da API](https://github.com/minio/minio/blob/master/docs/config/README.md), [compatibilidade S3](https://github.com/minio/docs/blob/main/source/reference/s3-api-compatibility.rst), [`mc anonymous`](https://github.com/minio/mc/blob/master/cmd/anonymous-main.go), [ações da política readonly](https://github.com/minio/minio-go/blob/master/pkg/policy/bucket-policy.go)
- Disponibilidade das imagens: [remoção do Docker Hub (StableBuild)](https://www.stablebuild.com/blog/minio-images-disappeared-from-docker-hub), [Silo](https://silo.pgsty.com/blog/post/minio-resurrect/), [CVE-2025-62506](https://asec.ahnlab.com/en/91238/)
- FFmpeg: [protocolos e `protocol_whitelist`](https://ffmpeg.org/ffmpeg-protocols.html)
- Sqids: [FAQ](https://sqids.org/faq)
