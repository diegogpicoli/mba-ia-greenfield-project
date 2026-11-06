---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-11-04T21:38:25.125388600-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-06T13:02:16.127626300-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-11-04T21:38:25.107346700-03:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-11-04T21:38:25.117393400-03:00"
  docs/phases/phase-02-auth/context.md: "2026-11-04T21:38:25.123389100-03:00"
  docs/phases/phase-02-auth-frontend/context.md: "2026-11-04T21:38:25.119390500-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-11-04T21:38:24.926590700-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Upload e Processamento de Vídeos

**Capabilities** (literal, `docs/project-plan.md`):

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** _Not specified._

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:**

_None explicitly mentioned in the Fase 03 block of project-plan.md._

**Deferred subprojects:** _None._

**Sequencing notes:** Depende de: Fase 01, Fase 02

**Neighbors (for boundary detection only):**

- **Phase 02:** Cadastro, Login e Gerenciamento de Conta — Depende de: Fase 01
- **Phase 04:** Gerenciamento de Vídeos e Canal — Depende de: Fase 02, Fase 03

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | phase | Backend | Tecnologia da fila de processamento | decided | A (BullMQ + Redis) | `bullmq@^6`, `ioredis`, `@nestjs/bullmq@11.0.5` |
| phase-03-videos/TD-02 | phase | Cross-layer | Estratégia de upload de até 10GB | decided | A (S3 Multipart pré-assinado) | `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner` |
|     └─ Last revision: 2026-11-06 — Repetir o `complete` em `draft` com `NoSuchUpload` confere o objeto com… | | | | | | |
| phase-03-videos/TD-03 | phase | Backend | Organização de buckets, chaves e endpoints do storage | decided | A (dois buckets) | `@aws-sdk/client-s3` |
| phase-03-videos/TD-04 | phase | Repo-wide | Origem da imagem Docker do MinIO | decided | A (build do fonte em commit fixo) | — |
| phase-03-videos/TD-05 | phase | Backend | Como o worker roda | decided | A (mesmo código, container próprio) | — |
|     └─ Last revision: 2026-11-06 — O `video-worker` recebe `env_file` com `.env.example` e `.env` opcional, e `sta… | | | | | | |
| phase-03-videos/TD-06 | phase | Backend | Extração de metadados e geração de thumbnail | decided | A (`spawn` com URL pré-assinada) | `ffmpeg` |
|     └─ Last revision: 2026-11-06 — `ffprobe` e `ffmpeg` recebem, além de `-protocol_whitelist`, `-format_whitelist… | | | | | | |
| phase-03-videos/TD-07 | phase | Backend | Estratégia de URL única | decided | A (base64url aleatório com `UNIQUE`) | — |
| phase-03-videos/TD-08 | phase | Cross-layer | Estratégia de streaming e download | decided | A (URL pré-assinada com HTTP Range) | `@aws-sdk/s3-request-presigner` |
|     └─ Last revision: 2026-11-06 — O campo da resposta se chama `expires_at`, no lugar do `expiresAt` da opção | | | | | | |
| phase-03-videos/TD-09 | phase | Backend | Ciclo de status do vídeo | decided | D (coluna única no ciclo do enunciado) | — |
|     └─ Last revision: 2026-11-06 — `VideosController` usa `@SkipThrottle()`, conforme `phase-02-auth/TD-08` | | | | | | |
| phase-03-videos/TD-10 | phase | Backend | O que acontece em caso de falha no processamento | decided | A (retries limitados, preservando o original) | `bullmq` |
|     └─ Last revision: 2026-11-06 — O listener usa `lastEventId: '0-0'` para reler os eventos retidos ao subir, e… | | | | | | |

_Source files:_

- phase-03-videos — docs/decisions/technical-decisions-phase-03-videos.md (scope_type: phase, related_phases: [3])

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-03, phase-03-videos/TD-04 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01, phase-03-videos/TD-05 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-02 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-02, phase-03-videos/TD-09 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-05, phase-03-videos/TD-06, phase-03-videos/TD-09, phase-03-videos/TD-10 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-06 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-07 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-08 |
| Download do vídeo pelo usuário | phase-03-videos/TD-08 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** Entrega sem código próprio o que o TD-10 precisa (retry com backoff, `UnrecoverableError`, detecção de job travado, deduplicação por `jobId`) e já é a referência da skill e do guia de testes do repo; o custo real é um container com estado a mais, que as opções sobre PostgreSQL evitariam, mas elas perdem a integração oficial com NestJS sem ganho relevante neste volume. Versões: `bullmq@^6`, `ioredis` explícito e `@nestjs/bullmq@11.0.5`, a última da linha 11, em CommonJS e com peer de `bullmq ^6` e Nest 11 (a `12.0.0` é só ESM). Serviço `redis` com imagem `redis:8.8`, `maxmemory-policy noeviction` e AOF ligado. Chaves `REDIS_HOST=redis` e `REDIS_PORT=6379` no schema Joi, em `.env.example` e no Compose. Na implementação, atualizar o `TBD` da Message Queue na descrição do `CLAUDE.md`.
**Libraries:** `bullmq@^6`, `ioredis`, `@nestjs/bullmq@11.0.5`

### phase-03-videos/TD-02

**Recommendation:** É a única opção que atende ao mesmo tempo "sem impacto na performance" e a retomada da seção 4 sem violar o BFF estrito; perde-se simplicidade no cliente, que fica com o fatiamento e o retry. Parâmetros do contrato: a API define o tamanho de parte (16 MiB, ou 640 partes em 10 GiB) e assina em lotes com validade de 1h; o limite de 10 GiB (10.737.418.240 bytes) é checado no início pelo tamanho declarado e de novo em `complete` pela soma do `ListParts`, abortando o upload se exceder; `complete` é idempotente e usa os ETags do `ListParts`, então o cliente não depende de ler o header `ETag`; o `upload_id` fica só no banco. O `S3Client` usa `requestChecksumCalculation: 'WHEN_REQUIRED'`, porque o padrão do SDK v3 (`WHEN_SUPPORTED`) embute CRC32 nas URLs de `UploadPart` (comportamento confirmado no código do SDK, ainda não testado contra o MinIO). O MinIO não suporta a regra de lifecycle `AbortIncompleteMultipartUpload` e expira uploads incompletos por `MINIO_API_STALE_UPLOADS_EXPIRY` (padrão 24h); como 10 GiB a 1 Mbit/s levam cerca de 24h, o Compose deve subir esse prazo para 7 dias. Na implementação, atualizar a descrição da API no `CLAUDE.md`.
**Libraries:** `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`

**Revisions:**
- 2026-11-05 — `complete` passa a receber do cliente a lista de `part_number` e `ETag`, e o `ListParts` fica só para verificar. Rationale: a AWS manda não montar o `complete` com a listagem, que omite parte em envio e poderia gerar vídeo truncado sem erro.
  A verificação confere partes 1..N, ETags e soma igual ao tamanho declarado; N é o teto do tamanho declarado dividido por 16 MiB, e o `ListParts` precisa ser paginado. Divergência responde erro sem abortar o upload, para o cliente reenviar, e exceder 10 GiB continua abortando. `CompleteMultipartUpload` usa a lista do cliente, e repetir o `complete` continua seguro. O cliente passa a ler o header `ETag`; em navegador isso depende de CORS, a conferir na fase que trouxer tela, já que a interface está fora desta fase. Esta revisão prevalece sobre o trecho da Recommendation que usa os ETags do `ListParts`.
- 2026-11-06 — Repetir o `complete` em `draft` com `NoSuchUpload` confere o objeto com `HeadObject` e segue se o tamanho bater; no JSON, o campo é `etag`. Rationale: cobre a queda entre fechar o multipart e gravar `processing`; o nome segue o snake_case do resto da API, e o header HTTP continua `ETag`.

### phase-03-videos/TD-03

**Recommendation:** Separa o risco dos vídeos da conveniência das thumbnails, ao custo de provisionar um bucket a mais e aceitar thumbnail de rascunho legível por quem tiver a URL. As chaves usam o UUID interno, nunca o ID público (TD-07) nem o nome do arquivo: assim não há texto do usuário na chave e reprocessar sobrescreve o mesmo objeto; o nome original fica no banco e só aparece no `Content-Disposition`. Não usar `mc anonymous set download`, que mapeia para a política `readonly` e inclui `s3:ListBucket`, expondo a lista de UUIDs de todos os vídeos. O provisionamento é idempotente via SDK (`CreateBucket` + `PutBucketPolicy` só com `s3:GetObject`), já que a imagem `minio/mc` também saiu do Docker Hub (TD-04). Endpoints: `S3_ENDPOINT=http://minio:9000` para as chamadas entre containers e `S3_PUBLIC_ENDPOINT=http://localhost:9000` apenas para assinar URLs destinadas ao navegador e montar URLs de thumbnail, sempre com `forcePathStyle: true`. Isso não viola a regra de rede do `CLAUDE.md`, porque nenhum container conecta nesse endereço: `getSignedUrl` calcula a assinatura sem acessar a rede. O worker assina com o endpoint interno. Chaves no schema Joi, em `.env.example` e no Compose: `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET_VIDEOS` e `S3_BUCKET_THUMBNAILS`. Os testes de integração usam o MinIO real do Compose, em vez do filesystem local descrito em `testing-guide-nestjs-project/references/external-systems.md`, porque multipart pré-assinado não existe nesse adaptador e o enunciado manda não mockar o que dá para testar com a infra do Compose.
**Libraries:** `@aws-sdk/client-s3`

### phase-03-videos/TD-04

**Recommendation:** Mantém a premissa de usar MinIO sem introduzir binário de terceiros e segue o caminho indicado pelo próprio projeto; o build foi testado em container descartável e gerou o binário em 130 s, sem cache de módulos. Perde-se tempo no primeiro `docker compose up` e correções futuras, então o código congelado serve para desenvolvimento e testes, e a Fase 07 (ambiente de produção) precisa reavaliar a origem do storage. Como a aplicação só conhece o contrato S3 (TD-03), trocar para a Option B depois exige mudar apenas o serviço no Compose, inclusive se o tempo de build atrapalhar quem for avaliar o projeto.
**Libraries:** —

### phase-03-videos/TD-05

**Recommendation:** Isola o custo de CPU da API e segue o diagrama sem duplicar entidades nem config; o preço é a disciplina de não carregar o processor na API e um `outDir` próprio para o worker em desenvolvimento. O `WorkerModule` importa só TypeORM, storage e o processor, e `AppModule` nunca o importa. O FFmpeg roda como processo filho via `spawn`, então o event loop fica livre para renovar o lock do BullMQ (padrão de 30 s) e o processor sandboxed não é necessário. A imagem do worker acrescenta `ffmpeg` por `apt`, seguindo o `Dockerfile.dev` atual. O worker começa a consumir sozinho no `docker compose up`, sem `docker compose exec`: o `command` do serviço substitui o `tail -f /dev/null` do `Dockerfile.dev`, roda `npm install` em um `node_modules` próprio, num volume, para funcionar em clone novo sem disputar com o da API, e inicia `src/worker.ts`; ao subir o contexto, o `BullRegistrar` registra o `@Processor` no `onModuleInit` e o consumo começa. `depends_on` com healthcheck de `db`, `redis` e `minio` garante a ordem, e `restart: unless-stopped` traz o worker de volta após uma queda, quando o BullMQ recupera o job travado. A regra do `nestjs-project/CLAUDE.md` de não iniciar a aplicação sem pedido trata do servidor HTTP e não é afetada, porque o worker não abre porta.
**Libraries:** —

**Revisions:**
- 2026-11-06 — `ffmpeg` entra no `Dockerfile.dev`, compartilhado por API e worker, e o `@QueueEventsListener` fica no processo do worker, junto do processor. Rationale: o `npm test` roda em `nestjs-api` e precisa do `ffmpeg`; a API continua sem chamá-lo, porque o processor não carrega nela.
  Esta revisão prevalece sobre o trecho da opção que diz que a imagem da API segue sem FFmpeg.
- 2026-11-06 — O `video-worker` recebe `env_file` com `.env.example` e `.env` opcional, e `start:worker` roda sem `--watch`. Rationale: um clone novo não tem `.env`, e a validação Joi exige as chaves. O `--watch` não percebe edição pelo bind mount e, com ele, o container não sairia para o `restart` agir; mudança no worker exige `docker compose restart video-worker`.

### phase-03-videos/TD-06

**Recommendation:** O custo do job deixa de crescer com o arquivo, o que importa com 10GB, e não entra dependência sem manutenção; perde-se a tolerância do arquivo local, e o job passa a depender da rede até o storage. Entrada por stdin fica descartada, porque sem seek um MP4 com o índice no fim não abre. Como o padrão do FFmpeg libera todos os protocolos, os dois comandos usam `-protocol_whitelist http,https,tcp,tls`, impedindo que uma playlist enviada como vídeo leia arquivos locais; os argumentos vão em array, sem shell. O frame é tirado em torno de 10% da duração, com recuo para o primeiro frame em vídeos muito curtos. Ficam salvos duração, largura, altura, codecs, bitrate e container. A classificação de erros está no TD-10.
**Libraries:** `ffmpeg`

**Revisions:**
- 2026-11-06 — `ffprobe` e `ffmpeg` recebem, além de `-protocol_whitelist`, `-format_whitelist` com os formatos de vídeo comuns e `-rw_timeout` de 60 s. Rationale: o whitelist de protocolos libera `http`, e uma playlist com segmento `http://` fazia o worker requisitar o endereço antes de falhar; a lista de formatos barra a playlist antes de qualquer requisição. Sem o timeout, uma conexão parada prenderia o job, com o lock do BullMQ sendo renovado.

### phase-03-videos/TD-07

**Recommendation:** Atende a "curta", "nunca conflita" e "não enumerável" sem dependência nova, reaproveitando o padrão de retry que o repo já tem; o que se perde é o alfabeto customizável do `nanoid`, sem efeito prático aqui. O identificador é gerado no pré-cadastro (TD-02), para existir desde o rascunho, e é imutável. O storage nunca usa esse valor (TD-03), então a URL pública fica desacoplada das chaves.
**Libraries:** —

### phase-03-videos/TD-08

**Recommendation:** Entrega streaming e download sem colocar bytes de vídeo no BFF ou na API e sem transcodificação fora do escopo; perde-se qualidade adaptativa e a garantia de reprodução em qualquer navegador. A URL vale 6h, e o cliente pede outra ao receber 403. O `Content-Type` é gravado no `CreateMultipartUpload`, e o nome original entra só no `Content-Disposition` do download. Só vídeos `ready` recebem URL. Não há publicação nesta fase e o acesso anônimo é bullet da Fase 05, então a API entrega URL apenas ao dono autenticado, e a Fase 05 abre a rota.
**Libraries:** `@aws-sdk/s3-request-presigner`

**Revisions:**
- 2026-11-06 — O campo da resposta se chama `expires_at`, no lugar do `expiresAt` da opção. Rationale: snake_case, como o resto da API.

### phase-03-videos/TD-09

**Recommendation:** É o ciclo que o enunciado pede, nasce rascunho como o plano exige e não antecipa nada da Fase 04; não há impedimento concreto, porque a retomada do upload usa o `ListParts` e não o status, e o custo é a Fase 04 precisar definir depois como representar a publicação. Os valores ficam em inglês, como os demais enums do código. Transições: `POST /videos` cria com `draft`; `complete` fecha o multipart, enfileira com `jobId = videoId` e só então grava `processing`, de modo que repetir a chamada é seguro; o worker grava `ready` junto com metadados e thumbnail, ou `error` (TD-10). A API expõe `status` no recurso do vídeo, para consulta por polling.
**Libraries:** —

**Revisions:**
- 2026-11-06 — `VideosController` usa `@SkipThrottle()`, conforme `phase-02-auth/TD-08`. Rationale: com o `ThrottlerGuard` global de 10 requisições por minuto, o polling de `status` receberia `429`.

### phase-03-videos/TD-10

**Recommendation:** Absorve falhas transitórias sem pedir novo upload de 10GB e falha rápido quando o arquivo é o problema; perde-se espaço em storage enquanto vídeos falhos existirem. Backoff exponencial com semente de 30 s. Falha permanente: `ffprobe` rejeita o arquivo ou não há stream de vídeo. O job é idempotente, porque reescreve a mesma chave de thumbnail e a mesma linha no banco. O status `error` é gravado por `QueueEvents` (`@QueueEventsListener`), cujo evento `failed` sempre traz o `jobId`, igual ao `videoId`; o evento `failed` do `Worker` não basta, porque o `job` pode vir indefinido quando um job travado estoura o limite. Reprocessar por endpoint não está em nenhum bullet da fase, então não entra aqui; preservar o original deixa essa porta aberta.
**Libraries:** `bullmq`

**Revisions:**
- 2026-11-05 — O `failure_code` da Option A não entra, e a falha fica registrada só pelo status `error`. Rationale: o enunciado não o pede e manda não inventar requisitos, e a justificativa era o painel da Fase 04.
- 2026-11-06 — O listener usa `lastEventId: '0-0'` para reler os eventos retidos ao subir, e grava `error` só `WHERE id = jobId AND status IN ('draft', 'processing')`. Rationale: um `failed` emitido com o processo fora do ar não se perde, e reler é seguro porque o `jobId` é único por vídeo e não há reprocessamento nesta fase; o `draft` entra porque o worker pode falhar antes de a API gravar `processing`.

## Inherited Decisions Detail

### phase-01-configuracao-base/TD-01

**Recommendation:** Option A (@nestjs/config) — Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem: the factory function can be imported as a plain function by `data-source.ts` while also serving as a DI injection token inside NestJS. Building a custom module recreates solved functionality; third-party packages carry maintenance risk.

**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Option A (Joi) — First-class integration with `@nestjs/config` via `validationSchema`, requiring zero custom wiring. Handles string-to-number coercion natively. Using a different tool for env validation vs. request validation is reasonable — env config is validated once at startup, DTOs are validated per-request. Zod is elegant but adds a third validation paradigm to the project.

**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** Option B (Namespaced/grouped with registerAs) — The project roadmap explicitly calls for auth, email, and storage in upcoming phases. Namespaced configs provide clear file boundaries per domain, typed injection via `ConfigType<typeof databaseConfig>`, and natural scalability. The `registerAs()` factory is dual-purpose: DI token inside NestJS and plain importable function for `data-source.ts`. Initial files for Phase 01: `src/config/database.config.ts`, `src/config/app.config.ts`.

**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** Option A (Shared registerAs factory) — Natural outcome of choosing `@nestjs/config` with `registerAs`. The factory is already callable by design. `data-source.ts` imports it, calls `dotenv.config()`, then calls the factory. Zero duplication, minimal code, no extra abstraction.

**Libraries:** `dotenv` (transitive via `@nestjs/config`)

### phase-02-auth/TD-01

**Recommendation:** Argon2id — For a greenfield project in 2026, Argon2id is the OWASP-recommended choice. The native build dependency is a one-time Docker setup cost. The project has no legacy constraints favoring bcrypt. OWASP minimum: 19MiB memory, 2 iterations.

**Libraries:** `argon2@^0.41.x`

### phase-02-auth/TD-02

**Recommendation:** Option A (@nestjs/passport) — The project plan includes only email/password auth for now, but the plugin architecture costs little and future phases may add social login. Aligns with official NestJS docs, making onboarding and maintenance easier.

**Note:** Decision deliberately diverged from the Recommendation during implementation — custom guards were preferred over `@nestjs/passport` to keep the dependency surface smaller; social login is not on the near-term roadmap, so the plugin-architecture benefit did not justify the extra abstraction layer.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-03

**Recommendation:** Option A (Refresh Token Rotation) — Provides the strongest security model with automatic theft detection. The DB write overhead is acceptable for a video platform (auth refresh is infrequent vs. video operations). PostgreSQL is already in the stack, so no new infrastructure needed. Race conditions can be mitigated with a short grace period for the old token.

**Libraries:** —

### phase-02-auth/TD-04

**Recommendation:** Option B (Random Opaque Tokens in DB) — Revocability is important: when a user requests a new password reset, previous tokens should be invalidated. The DB table is trivial to implement, and the tokens table can also serve future needs (e.g., API keys). Keeps email tokens decoupled from the JWT auth system.

**Libraries:** —

### phase-02-auth/TD-05

**Recommendation:** Option A (@nestjs-modules/mailer) — Best NestJS integration with minimal boilerplate. Supports SMTP (matching the architecture diagram), works with MailHog/Mailpit for local development without external dependencies, and scales to any SMTP provider in production. Template engine support (Handlebars) simplifies email formatting. No vendor lock-in.

**Libraries:** `@nestjs-modules/mailer@^2.x`, `handlebars@^4.x`

### phase-02-auth/TD-06

**Recommendation:** Option A (class-validator + class-transformer) — This is a backend-only project (no shared schemas with frontend), so Zod's single-source-of-truth advantage is less impactful. class-validator is the documented NestJS approach, and the project already uses decorators extensively (TypeORM entities, NestJS DI). Fewer integration surprises with NestJS 11.

**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Option A (Custom Domain Exception Filter) — Provides machine-readable error codes that the Next.js frontend can switch on, without the overhead of RFC 9457's URI-based type system. The project is single-consumer (first-party frontend), so a simple `{ statusCode, error, message }` format with domain codes balances clarity and simplicity. The custom filter cost is low — two small files.

**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** Option A (@nestjs/throttler) — Native NestJS integration is decisive: the guard system allows scoping rate limiting to `AuthModule` only via module-level `APP_GUARD`, with `@SkipThrottle()` for exemptions. The project is single-instance with no distributed requirements, so in-memory storage is sufficient. Using express-rate-limit would bypass NestJS's DI and guard lifecycle for no clear benefit.

**Libraries:** `@nestjs/throttler@^6.x`

### phase-02-auth/TD-09

**Recommendation:** Option B (Opaque) — Since DB lookup is mandatory (TD-03), JWT signature adds no security value. Opaque tokens are shorter, leak no data, and are simpler to generate.

**Note:** Decision deliberately diverged from the Recommendation — JWT was kept to reuse the access-token signing/verification infrastructure (`@nestjs/jwt`), trading token size and base64-readability for a single token format across the codebase.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-10

**Recommendation:** Option A — The platform is a video sharing service with URL-based channel handles. A strict `[a-z0-9_]` allowlist is the simplest and most portable choice: no extra dependencies, no edge cases around hyphen positioning, and the `user_<random>` fallback provides a valid handle even for extreme email prefixes. Hyphens can always be added in a future iteration if user feedback justifies it.

**Libraries:** —

### phase-02-auth-frontend/TD-01

**Recommendation:** Three reasons. (1) **Architectural fit.** The strict-BFF model in `next-frontend-config-base/TD-03` already nominates the Route Handler as the only NestJS caller; cookie-based sessions are the natural match, and Auth.js's framework adds layers between the BFF and the cookie that buy nothing because the backend is the auth authority — Auth.js's value (DB adapters, OAuth providers, magic-link, `getServerSession` helpers) is mostly unused in this configuration. (2) **Smaller blast radius.** A ~50-LOC session helper is grep-friendly, debuggable, and test-friendly via the existing MSW+BFF integration test pattern; a misconfigured Auth.js callback is a longer fault-isolation loop. (3) **Compatibility with Next.js 16 / React 19.** Built-in `next/headers` `cookies()` is the canonical primitive both runtimes already use; Auth.js v5 versions track Next.js majors with a lag, adding compatibility risk that Option A does not have. Option C is rejected as unsafe (`localStorage` for refresh tokens) and architecturally regressive (loses RSC personalization).
**Libraries:** —

### phase-02-auth-frontend/TD-02

**Recommendation:** Three reasons. (1) **Defense in depth on the cookie content** — `httpOnly` blocks JS, encryption blocks accidental log/proxy inspection; the marginal cost is one ~3KB dep. (2) **Single cookie to manage** simplifies logout (one `session.destroy()` call) and avoids the orphan-cookie failure mode of Option A. (3) **Room to carry minimal user metadata** (`userId`, `email`, `channelSlug`) lets `app/layout.tsx` RSC render the authenticated chrome (avatar, channel name) without a per-render `/auth/me` round-trip — Phase 04+ gains compound here. Option A is a viable downgrade if the team rejects `iron-session` for any reason; the migration A→B (or B→A) is a one-Route-Handler refactor with no test changes downstream because the BFF interface is unchanged. Option C is rejected: it solves a problem (server-side revocation) the project does not have at the cost of infrastructure the project does not own.
**Libraries:** iron-session

### phase-02-auth-frontend/TD-03

**Recommendation:** The single-flight detail is non-trivial and goes in the helper from day one — tested by MSW with a "two concurrent intercepted upstream calls; one refresh expected" assertion. Option B's client-driven pattern is rejected because it doesn't replace Option A (RSC still needs server-side refresh) — adopting B means doing both. Option C's pre-emptive timer is rejected because the failure modes (multiple tabs, sleep/wake) outweigh the latency saving and force a `"use client"` shell near the root.
**Libraries:** —

### phase-02-auth-frontend/TD-04

**Recommendation:** Three reasons. (1) **Decoupled from TD-05** — works with Route Handlers OR Server Actions; the form code does not change if TD-05 is revisited later. (2) **Aligned with shadcn's canonical form primitive** — the project already commits to `radix-nova` shadcn (`components.json`); `npx shadcn@latest add form` produces react-hook-form wrappers; choosing react-hook-form means using the supported primitive instead of hand-rolling around it. (3) **Zod-first developer ergonomics match the rest of the FE foundation** — `next-frontend-config-base/TD-01` chose Zod 4 for env; the same schemas-as-source-of-truth pattern carries to forms with zero new validator paradigm. Option B is rejected for impedance with shadcn's primitive and for over-investing in progressive-enhancement that the strict-BFF model does not require. Option C is rejected for the per-field boilerplate and the loss of client-side feedback on a project that values quick, type-safe form iteration.
**Libraries:** react-hook-form, @hookform/resolvers

### phase-02-auth-frontend/TD-05

**Recommendation:** Three reasons. (1) **Strict-BFF alignment.** `next-frontend-config-base/TD-03` named Route Handlers as the BFF surface; Option A keeps every mutation visible under `app/api/**`. (2) **Test scaffold already exists** — `next-frontend/CLAUDE.md` § Testing and `next-frontend-msw-foundation` were authored for Route-Handlers-as-functions; Option A reuses them with zero invention. (3) **Single mutation surface** — Phase 02 sets the precedent for Phases 03–07; uniformity beats per-mutation idiom-picking when the cost of inconsistency compounds (Option C). Option B has real ergonomic appeal for the simplest forms but fragments the BFF surface and forces test-pattern reinvention; if the team later wants progressive enhancement for specific forms, the migration A→B is per-form and doesn't require touching unrelated routes — A is the safer default and the cheaper baseline.
**Libraries:** —

### phase-02-auth-frontend/TD-06

**Recommendation:** Two reinforcing reasons. (1) **No first-render flicker, no round-trip** — the session is delivered in the same response as the page HTML; the Client Provider hydrates with the correct initial state; users never see "Login" briefly turn into their avatar. (2) **No new BFF endpoint** — the cookie is the source of truth, RSC reads it, the Provider broadcasts it; the BFF surface stays minimal. The `router.refresh()` requirement after mid-session mutations is a small price (one line in the relevant mutation handler) for the structural benefits. Option B is rejected for the double-read-and-flicker; Option C is dominated by Option B and rejected.
**Libraries:** —

### phase-02-auth-frontend/TD-07

**Recommendation:** Three reasons. (1) **First-paint-correct** — the user sees the right outcome on the first paint, no skeleton, no flicker. (2) **Single integration pattern across both flows** — confirmation is RSC-only; reset is RSC + Client form (TD-04, TD-05 patterns reused) — both share the "RSC owns the token, Client Component owns the input" split. (3) **Email-prefetch behavior** is solved at the backend's idempotent-confirmation level (a small note for `/plan-build` to confirm; not a separate TD). Option B's Route-Handler-as-link-target adds redirects for no clean gain. Option C is dominated.
**Libraries:** —

### openapi-docs-nestjs/TD-01

**Recommendation:** é a única opção que preserva as decisões anteriores (`class-validator` em TD-06 de phase-02-auth) sem re-platform; o CLI plugin com `classValidatorShim: true` aproveita os decoradores `class-validator` existentes para inferir schemas, mantendo o boilerplate baixo. Nestia tem mérito técnico real mas o custo de migração do stack de validação inviabiliza-a sem uma decisão upstream de supersede de TD-06. Manual authoring é descartado.

**Libraries:** @nestjs/swagger

**Revisions:**

- 2026-05-12 — Esclarece que o CLI plugin (`classValidatorShim: true`) cobre apenas inferência de schemas de DTOs a partir de `class-validator`; documentação de operações, respostas tipadas por status code, contratos de erro (alinhados ao envelope de phase-02-auth/TD-07) e exemplos exigem decoradores explícitos (`@ApiOperation`, `@ApiResponse`, `@ApiBody`, `@ApiParam`, `@ApiQuery`, `@ApiExtraModels`). _Rationale:_ openapi.json gerado pelo bootstrap atual está genérico — sem detalhes de parâmetros, schemas de retorno por status, nem contratos de erro — porque a base instalada se apoiou só na introspecção automática. Esta revisão fixa que enriquecimento via decoradores explícitos faz parte da Option A escolhida, não é trabalho fora do escopo do TD.

### openapi-docs-nestjs/TD-02

**Recommendation:** o custo marginal sobre Option A é apenas um npm script (~15 linhas) e o benefício é uma fundação correta para futura integração FE (codegen offline) sem perder a UI interativa que dev/QA usam. Option B sozinho pune a experiência de desenvolvimento em dev/local; Option A sozinho compromete o pipeline de codegen futuro. Combinar é dominante.

**Libraries:** —

### openapi-docs-nestjs/TD-03

**Recommendation:** alinha com a postura defensiva já estabelecida em phase 02 e não compromete consumidores legítimos (o `openapi.json` commitado em TD-02 cumpre o papel de "spec consultável fora da UI"). Re-abrir como Option A ou C é trivial no futuro se um caso de uso de API pública aparecer.

**Libraries:** —

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema,... _(from phase 01)_
- Config is injected into modules via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain function... _(from phase 01)_
- `data-source.ts` loads `.env` via `import 'dotenv/config'` at the top, then imports `databaseConfig` and calls it as a plain function. _(from phase 01)_
- Database connection parameters (host, port, etc.) are sourced from a single `databaseConfig` factory — never duplicated between `AppModule` and... _(from phase 01)_
- `TypeOrmModule.forRootAsync` is used (not `forRoot`), with `imports: [ConfigModule]`, `inject: [databaseConfig.KEY]`, `useFactory` returning... _(from phase 01)_

## Inherited Deferred Capabilities

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| Telas de frontend | deferred | phase-01-configuracao-base | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| Telas de cadastro, login, confirmação de conta e recuperação de senha | deferred | phase-02-auth | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| "Confirmação de conta via e-mail com link de ativação" | deferred | phase-02-auth-frontend | deferred_to_next_phase — UI landing screen de-scoped 2026-05-14; FE confirmation flow (TD-07) picked up by a future phase. BE side unchanged in `phase-02-auth`. |
| "Logout" | deferred | phase-02-auth-frontend | deferred_to_next_phase — logout button lives inside authenticated chrome (typically Phase 04). Phase 02 still implements POST `/api/auth/logout` (BFF route handler + `session.destroy()`) so the contract is ready when the chrome lands. |
| "Recuperação de senha (destination screen / set-new-password)" | deferred | phase-02-auth-frontend | deferred_to_next_phase — `/forgot-password` ships this phase sending the e-mail; the reset-password destination screen is absent from Figma → link destination remains a 404 until a later phase delivers the screen via `/screen-inventory` extension run. Documented as a known gap. |
| "Telas de cadastro, login, confirmação de conta e recuperação de senha" | deferred | phase-02-auth-frontend | a tela de confirmação da conta não será implementada nesta fase corrente, será adiada — the umbrella bullet's full coverage requires the confirmação and reset-password destination screens; both are deferred per Non-UI rows above. The 3 ship-this-phase telas (signup, login, forgot-password) are inventoried and covered by their own verbs; the umbrella bullet itself is deferred to the phase that lands the missing screens. |

## UI Inventory

_No screen inventory — UI↔API sync deferred. Run /screen-inventory 3 and then rerun /plan-context 3 to activate UI checks._

## Non-UI / Deferred Capabilities

_None._

## Testing Requirements

### nestjs-project

| Artifact type | Required layers |
|---------------|-----------------|
| Entity (`*.entity.ts`) | Integration: constraints, defaults, `select: false` |
| Service with branching + DB | Unit: branch logic (mock repo) + Integration: DB contract |
| Service with DB only (no branching) | Integration: DB contract |
| Service with configured lib (JWT, cache) | Unit: real lib with test config |
| Service with side-effect dep (email, storage) | Integration: real capture service (Mailpit) or local adapter |
| Module with configured imports | Unit: compilation test |
| Controller | E2E only — do NOT write unit tests |
| DTO | E2E: one validation wiring test per endpoint |
| Guard (delegates to service for business logic) | E2E + Unit if complex internal logic |
| Guard (simple, delegates to Passport) | E2E only |
| Strategy (Passport) | E2E via guard |
| Pipe (custom transformation/validation) | Unit |
| Interceptor (response transform, logging) | Unit and/or E2E |
| Exception Filter | Unit + E2E |
| Middleware | E2E |
