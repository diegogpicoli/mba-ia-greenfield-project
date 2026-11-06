---
kind: phase
name: phase-03-videos
test_specs_aware: true
affected_subprojects:
  - nestjs-project
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-11-06T09:43:10.326543500-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-11-06T09:39:18.208519500-03:00"
  docs/project-plan.md: "2026-11-04T21:38:25.125388600-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-06T09:39:03.497955700-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-11-04T21:38:25.107346700-03:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-11-04T21:38:25.117393400-03:00"
  docs/phases/phase-02-auth/context.md: "2026-11-04T21:38:25.123389100-03:00"
  docs/phases/phase-02-auth-frontend/context.md: "2026-11-04T21:38:25.119390500-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-11-04T21:38:24.926590700-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Entregar o upload de vídeos de até 10GB sem impacto na performance, com pré-cadastro automático do vídeo como rascunho ao iniciar o upload, processamento automático em segundo plano (extração de duração e metadados e geração de thumbnail), URL única por vídeo, reprodução via streaming e download do vídeo pelo usuário, sobre serviços reais de armazenamento e de filas.

---

## Step Implementations

### SI-03.1 — Infra: Redis, MinIO e FFmpeg no Compose

**Description:** Sobe os serviços reais de fila e de armazenamento e deixa o FFmpeg disponível onde o worker e os testes rodam.

**Technical actions:**

1. Criar `docker/minio/Dockerfile` multi-stage: compila com `go install github.com/minio/minio@9e49d5e7a648` em `golang:1.24-alpine` e copia o binário para uma imagem mínima com `curl`, usado no healthcheck (per `phase-03-videos/TD-04`)
2. Acrescentar o serviço `minio` ao `compose.yaml` com `build:`, porta `9000`, `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`, `MINIO_API_STALE_UPLOADS_EXPIRY=168h` (7 dias, per `phase-03-videos/TD-02`), volume nomeado e healthcheck em `/minio/health/live`
3. Acrescentar o serviço `redis` com imagem `redis:8.8`, `maxmemory-policy noeviction`, AOF ligado, volume nomeado e healthcheck com `redis-cli ping` (per `phase-03-videos/TD-01`)
4. Acrescentar `ffmpeg` ao `apt install` do `Dockerfile.dev`, compartilhado por API e worker, porque o `npm test` roda em `nestjs-api` e precisa dele (per `phase-03-videos/TD-05`)
5. Acrescentar `redis` e `minio` ao `depends_on` de `nestjs-api`, com `condition: service_healthy`

**Tests:** _(empty — Infra)_

**Dependencies:** none

**Acceptance criteria:**

- `docker compose up -d` deixa `redis` e `minio` como `healthy` em `docker compose ps`
- `docker compose config` mostra `minio` com `build:`, sem `image:`, e com `MINIO_API_STALE_UPLOADS_EXPIRY=168h`
- `docker compose exec redis redis-cli config get maxmemory-policy` retorna `noeviction`, e `config get appendonly` retorna `yes`
- `docker compose exec nestjs-api ffmpeg -version` e `docker compose exec nestjs-api ffprobe -version` terminam com código 0

---

### SI-03.2 — Infra: dependências, configs `queue` e `storage`, schema Joi e `.env.example`

**Description:** Instala as libs decididas e valida no boot as chaves que apontam para fila e storage, seguindo as convenções de config herdadas.

**Technical actions:**

1. Instalar no container `nestjs-api`: `bullmq@^6`, `@nestjs/bullmq@11.0.5` (versão exata), `ioredis@^5.11.1`, `@aws-sdk/client-s3@^3` e `@aws-sdk/s3-request-presigner@^3` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-02`)
2. Criar `src/config/queue.config.ts` com `registerAs('queue', ...)` lendo `REDIS_HOST` e `REDIS_PORT` (per `phase-03-videos/TD-01`, `phase-01-configuracao-base/TD-03`)
3. Criar `src/config/storage.config.ts` com `registerAs('storage', ...)` lendo `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET_VIDEOS` e `S3_BUCKET_THUMBNAILS` (per `phase-03-videos/TD-03`, `phase-01-configuracao-base/TD-03`)
4. Acrescentar as nove chaves como obrigatórias em `src/config/env.validation.ts` e os dois namespaces ao `load` do `ConfigModule` em `AppModule` (per `phase-01-configuracao-base/TD-02`)
5. Acrescentar as chaves ao `.env.example` e ao `.env` local: `REDIS_HOST=redis`, `REDIS_PORT=6379`, `S3_ENDPOINT=http://minio:9000`, `S3_PUBLIC_ENDPOINT=http://localhost:9000`, `S3_REGION=us-east-1`, `S3_ACCESS_KEY` e `S3_SECRET_KEY` iguais às credenciais do `minio` no Compose, `S3_BUCKET_VIDEOS=streamtube-videos` e `S3_BUCKET_THUMBNAILS=streamtube-thumbnails` (per `phase-03-videos/TD-03`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `envValidationSchema` | Integration: cada chave nova é obrigatória | `src/config/env.validation.integration-spec.ts` |

**Dependencies:** SI-03.1 — as chaves apontam para os serviços do Compose

**Acceptance criteria:**

- Subir a aplicação sem `S3_ENDPOINT` falha no boot, com erro de validação que cita a chave
- Subir a aplicação sem `REDIS_HOST` falha no boot, com erro de validação que cita a chave
- `.env.example` usa `redis` e `minio` como hosts, e `S3_PUBLIC_ENDPOINT` é a única chave nova com `localhost`
- `package.json` lista `@nestjs/bullmq` exatamente em `11.0.5`

---

### SI-03.3 — Entidade `Video` e migration `CreateVideos`

**Description:** Cria a persistência do vídeo ligada ao canal e mantém as suítes existentes funcionando com a tabela e a relação novas.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` com a entidade `Video` e o enum `VideoStatus`, conforme `### Data Model`. `declared_size` e `bitrate` usam transformer de `bigint` para `number`, porque o TypeORM devolve `bigint` como texto e o contrato diz integer (per `phase-03-videos/TD-09`)
2. Acrescentar `Channel.videos` (`@OneToMany`) e incluir `Video` nas listas de entidades das 11 specs que já listam `Channel`, porque o TypeORM não resolve a relação sem a entidade na lista
3. Gerar `src/database/migrations/<timestamp>-CreateVideos.ts` com `npm run migration:generate`, dentro do container, e revisar enum, FK, `UNIQUE` e `down()`
4. Em `src/test/create-test-data-source.ts`, fazer `cleanAllTables` apagar `videos` antes de `channels`; em `src/database/migrations.integration-spec.ts`, acrescentar `videos` a `MANAGED_TABLES`, a migration nova à lista e à contagem, o `DROP TYPE` de `videos_status_enum` e ajustar o teste de reversão, porque a última migration passa a ser `CreateVideos`
5. Criar `src/videos/videos.module.ts` só com `TypeOrmModule.forFeature([Video])` e importá-lo em `AppModule`, porque `AppModule` usa `autoLoadEntities` e não resolve `Channel.videos` sem `Video` registrada

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: `public_id` único, default `draft`, valor inválido de `status`, FK de `channel_id`, `bigint` lido como `number` | `src/videos/entities/video.entity.integration-spec.ts` |
| Migrations | Integration: aplica as três migrations e reverte `CreateVideos` | `src/database/migrations.integration-spec.ts` |
| `AppModule` | E2E: sobe com a relação `Channel.videos` | `test/app.e2e-spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- Inserir dois vídeos com o mesmo `public_id` — violação de `UNIQUE`
- Inserir um vídeo sem `status` — persiste com `draft`
- Inserir um vídeo com `status` fora de `draft`, `processing`, `ready` e `error` — rejeitado pelo banco
- Inserir um vídeo com `channel_id` inexistente — violação de FK
- Gravar `declared_size` igual a 10737418240 — a leitura pela entidade devolve o `number` 10737418240
- `npm run migration:run` cria a tabela `videos`, e `npm run migration:revert` remove a tabela e o tipo `videos_status_enum`
- `AppModule` sobe com a relação `Channel.videos`, provado por `test/app.e2e-spec.ts`

---

### SI-03.4 — Serviço de storage: multipart, assinatura e buckets

**Description:** Concentra o acesso ao object storage em um módulo próprio, usado pela API e pelo worker, e prova o multipart pré-assinado contra o MinIO real.

**Technical actions:**

1. Criar `src/storage/storage.service.ts` com um `S3Client` para `S3_ENDPOINT` e outro para `S3_PUBLIC_ENDPOINT`, ambos com `forcePathStyle: true` e `requestChecksumCalculation: 'WHEN_REQUIRED'` (per `phase-03-videos/TD-02`, `phase-03-videos/TD-03`)
2. Implementar `CreateMultipartUpload`, `ListParts` com paginação por `NextPartNumberMarker`, `CompleteMultipartUpload`, `AbortMultipartUpload` e `HeadObject`. `NoSuchUpload` vira `UploadNotFoundException` (`UPLOAD_NOT_FOUND`), nova em `src/common/exceptions/domain.exception.ts` (per `phase-03-videos/TD-02`)
3. Implementar a assinatura com `getSignedUrl`: `UploadPart` pelo endpoint público com validade de 1h, `GetObject` pelo endpoint público com validade de 6h e `ResponseContentDisposition` opcional, e `GetObject` pelo endpoint interno para o worker; e o envio de thumbnail com `PutObject` (per `phase-03-videos/TD-02`, `phase-03-videos/TD-03`, `phase-03-videos/TD-08`)
4. Provisionar os buckets no `onModuleInit`, de forma idempotente, com `CreateBucket` e `PutBucketPolicy` só com `s3:GetObject` no bucket de thumbnails, sem usar `mc anonymous set download` (per `phase-03-videos/TD-03`)
5. Criar `src/storage/storage.module.ts`, que exporta `StorageService`, e o helper de teste `src/test/presigned-request.ts`, que conecta em `S3_ENDPOINT` enviando o `Host` da URL assinada, porque dentro do container `localhost:9000` não é o MinIO e a assinatura cobre o host

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageService` | Integration (MinIO real): upload em duas partes acima de 16 MiB por URL pré-assinada, `ListParts` paginado, fechamento, aborto e `NoSuchUpload` | `src/storage/storage.service.integration-spec.ts` |
| `StorageService` | Integration (MinIO real): provisionamento repetido, leitura anônima de thumbnail, listagem negada e `Range` | `src/storage/storage.service.integration-spec.ts` |
| `StorageModule` | Unit: compilação | `src/storage/storage.module.spec.ts` |

**Dependencies:** SI-03.1 — MinIO em execução; SI-03.2 — config `storage` e SDK instalados

**Acceptance criteria:**

- Enviar um arquivo acima de 16 MiB em duas partes, com `PUT` nas URLs assinadas para `S3_PUBLIC_ENDPOINT`, devolve o header `ETag` em cada parte, e fechar o multipart gera um objeto com o tamanho total
- As URLs de `UploadPart` não carregam parâmetros de checksum CRC32, e o MinIO aceita o `PUT`
- `GET` assinado com `Range: bytes=0-1023` responde `206` com `Content-Range`
- Iniciar o serviço duas vezes seguidas não falha, e os dois buckets continuam existindo
- `GET` anônimo em um objeto de `streamtube-thumbnails` responde `200`, e `GET` anônimo na raiz do mesmo bucket responde `403`
- `GET` anônimo em um objeto de `streamtube-videos` responde `403`
- Listar partes de um upload abortado resulta em `UPLOAD_NOT_FOUND`

---

### SI-03.5 — Infra: worker em processo próprio

**Description:** Cria o entrypoint e o serviço `video-worker`, que passa a rodar sozinho no `docker compose up`, separado do processo da API.

**Technical actions:**

1. Criar `src/videos/videos.constants.ts` com `VIDEO_PROCESSING_QUEUE = 'video-processing'`, `PROCESS_VIDEO_JOB = 'process-video'`, o tamanho de parte de 16 MiB e o limite de 10737418240 bytes (per `phase-03-videos/TD-02`)
2. Criar `src/worker.module.ts` com `WorkerModule`: `ConfigModule`, `TypeOrmModule.forRootAsync` com `forFeature([Video, Channel, User])`, exigido pelas relações, `BullModule.forRootAsync`, `BullModule.registerQueue` e `StorageModule`. `AppModule` nunca o importa (per `phase-03-videos/TD-05`)
3. Criar `src/worker.ts`, que sobe com `NestFactory.createApplicationContext(WorkerModule)`, sem HTTP (per `phase-03-videos/TD-05`)
4. Criar `tsconfig.worker.json` com `outDir` próprio (`dist-worker`), o script `start:worker` no `package.json` e a entrada no `.gitignore`, porque `deleteOutDir: true` apagaria o `dist` da API (per `phase-03-videos/TD-05`)
5. Acrescentar o serviço `video-worker` ao `compose.yaml`, com o mesmo `Dockerfile.dev`, `command` que roda `npm install` e `npm run start:worker`, `node_modules` em volume nomeado próprio, criado com dono `node` no `Dockerfile.dev`, `depends_on` com healthcheck de `db`, `redis` e `minio`, e `restart: unless-stopped`, sem portas (per `phase-03-videos/TD-05`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `WorkerModule` | Unit: compilação, sem `init`, para não subir um segundo consumidor | `src/worker.module.spec.ts` |

**Dependencies:** SI-03.1 — serviços com healthcheck; SI-03.2 — configs e BullMQ; SI-03.3 — entidade `Video`; SI-03.4 — `StorageModule`

**Acceptance criteria:**

- `docker compose up -d` em um clone novo deixa `video-worker` em execução, sem nenhum `docker compose exec`
- `docker compose logs video-worker` mostra o contexto iniciado, e o serviço não publica nenhuma porta
- Encerrar o processo principal do `video-worker` faz o container voltar a rodar sozinho
- Com o `video-worker` em execução, o `dist` da API continua intacto

---

### SI-03.6 — Extração de metadados e thumbnail com FFmpeg

**Description:** Encapsula as chamadas a `ffprobe` e `ffmpeg`, que leem o vídeo por URL pré-assinada, sem baixar o arquivo.

**Technical actions:**

1. Criar `src/videos/video-media.service.ts` com `probe`, que roda `ffprobe -protocol_whitelist http,https,tcp,tls -show_format -show_streams -of json <url>` por `spawn`, com argumentos em array e sem shell, e devolve `duration`, `width`, `height`, `video_codec`, `audio_codec`, `bitrate` e `container` (per `phase-03-videos/TD-06`)
2. Conferir na imagem do worker a saída JSON e os nomes de campo do `ffprobe`, lacuna registrada em `library-refs.md`
3. Implementar `extractThumbnail`, que roda `ffmpeg -protocol_whitelist http,https,tcp,tls -ss T -i <url> -frames:v 1 <saida>`, com o frame em torno de 10% da duração e recuo para o primeiro frame em vídeos muito curtos (per `phase-03-videos/TD-06`)
4. Sinalizar com `VideoFileRejectedError` quando o `ffprobe` rejeita o arquivo ou não há stream de vídeo (per `phase-03-videos/TD-10`)
5. Criar o helper `src/test/generate-test-video.ts`, que gera vídeos de teste com `ffmpeg -f lavfi`, sem binário commitado

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoMediaService` | Integration: `ffprobe` e `ffmpeg` reais lendo do MinIO por URL pré-assinada | `src/videos/video-media.service.integration-spec.ts` |
| `VideoMediaService` | Unit: leitura da saída do `ffprobe` e cálculo da posição do frame | `src/videos/video-media.service.spec.ts` |

**Dependencies:** SI-03.1 — FFmpeg na imagem; SI-03.4 — URL pré-assinada

**Acceptance criteria:**

- Um vídeo 640x360 de 5 segundos com áudio devolve duração próxima de 5, largura 640, altura 360, os dois codecs, bitrate maior que zero e container preenchido
- Um vídeo sem áudio devolve `audio_codec` nulo
- Um vídeo de um único frame gera thumbnail
- Um arquivo de texto resulta em `VideoFileRejectedError`
- Uma playlist que aponta para `file:///etc/passwd` não lê o arquivo local e resulta em `VideoFileRejectedError`

---

### SI-03.7 — Processamento do vídeo no worker

**Description:** Consome `process-video`: extrai metadados, gera a thumbnail e marca o vídeo como `ready`, de forma idempotente.

**Technical actions:**

1. Criar `src/videos/video-processing.service.ts` com `process(videoId)`: assina a leitura de `source_key` pelo endpoint interno, roda `probe` e `extractThumbnail` e envia a thumbnail a `{videoId}/thumbnail.jpg` (per `phase-03-videos/TD-03`, `phase-03-videos/TD-06`)
2. Gravar `ready`, metadados e `thumbnail_key` em uma única atualização e remover o arquivo temporário da thumbnail (per `phase-03-videos/TD-09`, `phase-03-videos/TD-10`)
3. Classificar as falhas: `VideoFileRejectedError` e vídeo inexistente lançam `UnrecoverableError`; as demais são relançadas para nova tentativa (per `phase-03-videos/TD-10`)
4. Criar `src/videos/video.processor.ts` com `@Processor(VIDEO_PROCESSING_QUEUE)` + `WorkerHost`, que recebe `{ videoId }` e delega ao serviço (per `phase-03-videos/TD-01`)
5. Registrar `VideoMediaService`, `VideoProcessingService` e `VideoProcessor` em `WorkerModule` (per `phase-03-videos/TD-05`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessor` | Integration: chama `process` direto, com Postgres, MinIO e FFmpeg reais e sem `BullModule`, para não subir um segundo consumidor | `src/videos/video.processor.integration-spec.ts` |
| `VideoProcessingService` | Unit: classificação de falhas | `src/videos/video-processing.service.spec.ts` |

**Dependencies:** SI-03.5 — `WorkerModule`; SI-03.6 — `VideoMediaService`

**Acceptance criteria:**

- Processar um vídeo válido grava `status` igual a `ready`, com os metadados e `thumbnail_key` preenchidos
- A thumbnail gerada fica legível em `{S3_BUCKET_THUMBNAILS}/{videoId}/thumbnail.jpg`
- Processar o mesmo vídeo duas vezes mantém uma única linha e a mesma `thumbnail_key`
- Processar um arquivo inválido resulta em `UnrecoverableError`, e o objeto em `source_key` continua no storage
- Processar um `videoId` inexistente resulta em `UnrecoverableError`
- Uma falha de acesso ao storage é relançada como erro comum, sujeita a nova tentativa

---

### SI-03.8 — Registro da falha no `status`

**Description:** Reflete no banco o job que falhou de vez, sem depender do evento do `Worker` e sem perder falhas emitidas com o processo fora do ar.

**Technical actions:**

1. Criar `VideoProcessingService.markFailed(jobId)`, que grava `error` só `WHERE id = jobId AND status IN ('draft', 'processing')` (per `phase-03-videos/TD-10`)
2. Criar `src/videos/video-events.listener.ts` com `@QueueEventsListener(VIDEO_PROCESSING_QUEUE, { lastEventId: '0-0' })` + `QueueEventsHost` e `@OnQueueEvent('failed')`, que delega a `markFailed`. O handler captura o erro, registra em log e não relança, como manda a seção "Background tasks, event handlers e cron jobs" de `.claude/rules/nestjs-services.md` (per `phase-03-videos/TD-10`)
3. Confirmar nos tipos do pacote Node a opção `lastEventId` e a forma do argumento do handler, objeto ou posicional, divergência registrada em `library-refs.md`
4. Registrar `VideoEventsListener` em `WorkerModule`, no mesmo processo do processor (per `phase-03-videos/TD-05`, `phase-03-videos/TD-09`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoEventsListener` | Integration: handler chamado direto, com Postgres real e sem `BullModule`, para não subir um segundo consumidor; inclui falha de `markFailed` registrada em log, sem relançar | `src/videos/video-events.listener.integration-spec.ts` |

**Dependencies:** SI-03.7 — `VideoProcessingService`

**Acceptance criteria:**

- Uma falha ao gravar `error` é registrada em log, e o processo do `video-worker` continua em execução
- Um `failed` de vídeo em `processing` grava `error`, e o objeto em `source_key` continua no storage
- Um `failed` de vídeo em `draft` grava `error`
- Um `failed` de vídeo em `ready` não altera o `status`
- Um `failed` com `jobId` sem vídeo correspondente não gera erro
- Depois de `docker compose restart video-worker`, um `failed` retido no stream grava `error` no vídeo que ainda estava em `processing`

---

### SI-03.9 — Endpoint POST /videos

**Route:** POST /videos
**Test Specs:** see `nestjs-project/specs/videos-create.plan.md`
**Authorization:** Authenticated

**Description:** Inicia o upload: valida o tamanho, abre o multipart e pré-cadastra o vídeo como rascunho no canal do usuário.

**Technical actions:**

1. Criar `ChannelsService.findByUserId`, porque buscar o canal é responsabilidade de `ChannelsModule`
2. Criar `src/videos/dto/create-video.dto.ts`, os DTOs de resposta e `VideoTooLargeException` (`VIDEO_TOO_LARGE`), conforme `### API Contracts → POST /videos`
3. Criar `src/videos/videos.service.ts` com `createDraft`, seguindo o `**Behavior:**` do contrato, inclusive a nova tentativa em colisão `23505` no mesmo padrão de `ChannelsService` (per `phase-03-videos/TD-02`, `phase-03-videos/TD-07`)
4. Criar `src/videos/videos.controller.ts` com `@SkipThrottle()` na classe (per `phase-02-auth/TD-08`), `@Post()`, `@ApiBearerAuth('access-token')`, `@ApiOperation` e `@ApiResponse` com `ApiErrorEnvelope` para cada erro (per `openapi-docs-nestjs/TD-01`, `phase-02-auth/TD-07`)
5. Ampliar `src/videos/videos.module.ts`, criado na SI-03.3, com `ChannelsModule` e `StorageModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService` | Unit: limite de tamanho, `part_count` e nova tentativa em `23505` | `src/videos/videos.service.spec.ts` |
| `VideosService` | Integration: Postgres e MinIO reais; rascunho gravado com multipart aberto | `src/videos/videos.service.integration-spec.ts` |
| `ChannelsService` | Integration: `findByUserId` | `src/channels/channels.service.integration-spec.ts` |
| `VideosModule` | Unit: compilação | `src/videos/videos.module.spec.ts` |

**Dependencies:** SI-03.3 — entidade `Video`; SI-03.4 — `StorageService`; SI-03.5 — constantes de `videos`

**Acceptance criteria:**

- `POST /videos` com payload válido retorna `201` com `public_id` de 11 caracteres, `status` igual a `draft`, `title` igual a `original_filename`, `part_size` igual a 16777216 e `part_count` calculado
- `POST /videos` com `declared_size` igual a 10737418240 retorna `201` com `part_count` igual a 640
- `POST /videos` com `declared_size` igual a 10737418241 retorna `413` com `error: "VIDEO_TOO_LARGE"`
- `POST /videos` sem `content_type` retorna `400` com `error: "VALIDATION_ERROR"`
- `POST /videos` sem token retorna `401`
- A resposta não traz `id` nem `upload_id`
- Depois do `201`, a linha do vídeo pertence ao canal do usuário, com `upload_id` preenchido e `source_key` igual a `{id}/source`, e o multipart existe no storage

---

### SI-03.10 — Endpoint GET /videos/{publicId}

**Route:** GET /videos/{publicId}
**Test Specs:** see `nestjs-project/specs/videos-get.plan.md`
**Authorization:** Owner

**Description:** Expõe o recurso do vídeo para consulta do `status` por polling e estabelece a checagem de dono usada pelos demais endpoints.

**Technical actions:**

1. Criar `VideosService.findOwned(publicId, userId)` e `VideoNotFoundException` (`VIDEO_NOT_FOUND`), usada para vídeo inexistente e para vídeo de outro canal (per `### Authorization Matrix`)
2. Mapear a entidade para `VideoResponseDto`, com `thumbnail_url` montada a partir de `S3_PUBLIC_ENDPOINT`, `S3_BUCKET_THUMBNAILS` e `thumbnail_key` (per `phase-03-videos/TD-03`)
3. Acrescentar `@Get(':publicId')` a `VideosController`, com as anotações OpenAPI (per `openapi-docs-nestjs/TD-01`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService` | Unit: mapeamento do recurso e `thumbnail_url` | `src/videos/videos.service.spec.ts` |
| `VideosService` | Integration: `findOwned` com dono, outro canal e `public_id` inexistente | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.9 — módulo, serviço e controller de `videos`

**Acceptance criteria:**

- `GET /videos/{publicId}` do dono, com vídeo em `draft`, retorna `200` com `status` igual a `draft`, metadados nulos e `thumbnail_url` nula
- `GET /videos/{publicId}` do dono, com vídeo em `ready`, retorna `200` com metadados e `thumbnail_url` preenchidos
- `GET /videos/{publicId}` de outro usuário retorna `404` com `error: "VIDEO_NOT_FOUND"`, igual à resposta de um `public_id` inexistente
- `GET /videos/{publicId}` sem token retorna `401`
- A resposta não traz `id`, `channel_id`, `upload_id` nem `source_key`
- Mais de 10 `GET /videos/{publicId}` em um minuto não recebem `429`

---

### SI-03.11 — Endpoint POST /videos/{publicId}/parts/sign

**Route:** POST /videos/{publicId}/parts/sign
**Test Specs:** see `nestjs-project/specs/videos-parts-sign.plan.md`
**Authorization:** Owner

**Description:** Assina sob demanda as partes do upload, para o cliente enviar os bytes direto ao storage.

**Technical actions:**

1. Criar `src/videos/dto/sign-parts.dto.ts` e o DTO de resposta, conforme `### API Contracts → POST /videos/{publicId}/parts/sign`
2. Criar `VideoUploadClosedException` (`VIDEO_UPLOAD_CLOSED`) e `UploadPartOutOfRangeException` (`UPLOAD_PART_OUT_OF_RANGE`) (per `### Error Catalog`)
3. Criar `VideosService.signParts`, que exige `status` igual a `draft` e números dentro de `part_count` e assina com validade de 1h (per `phase-03-videos/TD-02`)
4. Acrescentar `@Post(':publicId/parts/sign')` com `@HttpCode(200)` a `VideosController`, com as anotações OpenAPI (per `openapi-docs-nestjs/TD-01`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService` | Unit: `status` e faixa de números | `src/videos/videos.service.spec.ts` |
| `VideosService` | Integration: URL assinada aceita o `PUT` no MinIO real | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.10 — checagem de dono

**Acceptance criteria:**

- `POST /videos/{publicId}/parts/sign` com `part_numbers` igual a `[1, 2]`, em vídeo `draft`, retorna `200` com duas URLs e `expires_at` cerca de 1h à frente
- `PUT` de 16 MiB em uma URL devolvida responde `200` com o header `ETag`
- `part_numbers` com número acima de `part_count` retorna `400` com `error: "UPLOAD_PART_OUT_OF_RANGE"`
- `part_numbers` vazio ou com repetição retorna `400` com `error: "VALIDATION_ERROR"`
- Vídeo em `processing` retorna `409` com `error: "VIDEO_UPLOAD_CLOSED"`
- Chamada de outro usuário retorna `404` com `error: "VIDEO_NOT_FOUND"`, e chamada sem token retorna `401`

---

### SI-03.12 — Endpoint GET /videos/{publicId}/parts

**Route:** GET /videos/{publicId}/parts
**Test Specs:** see `nestjs-project/specs/videos-parts-list.plan.md`
**Authorization:** Owner

**Description:** Permite retomar o upload, informando o que já chegou ao storage e o que falta enviar.

**Technical actions:**

1. Criar o DTO de resposta, conforme `### API Contracts → GET /videos/{publicId}/parts`
2. Criar `VideosService.getUploadProgress`, que exige `status` igual a `draft`, consulta o `ListParts` e calcula `missing_part_numbers` a partir de `part_count` (per `phase-03-videos/TD-02`, `phase-03-videos/TD-09`)
3. Acrescentar `@Get(':publicId/parts')` a `VideosController`, com as anotações OpenAPI (per `openapi-docs-nestjs/TD-01`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService` | Unit: cálculo das partes faltantes | `src/videos/videos.service.spec.ts` |
| `VideosService` | Integration: progresso real no MinIO, antes e depois de enviar uma parte | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.11 — partes assinadas

**Acceptance criteria:**

- `GET /videos/{publicId}/parts` sem nenhuma parte enviada retorna `200` com `uploaded_parts` vazio e todos os números em `missing_part_numbers`
- Depois de enviar a parte 1 de 2, retorna `uploaded_parts` com `part_number` 1 e `etag`, e `missing_part_numbers` igual a `[2]`
- Vídeo fora de `draft` retorna `409` com `error: "VIDEO_UPLOAD_CLOSED"`
- Upload abortado retorna `409` com `error: "UPLOAD_NOT_FOUND"`
- Chamada de outro usuário retorna `404` com `error: "VIDEO_NOT_FOUND"`, e chamada sem token retorna `401`

---

### SI-03.13 — Endpoint POST /videos/{publicId}/complete

**Route:** POST /videos/{publicId}/complete
**Test Specs:** see `nestjs-project/specs/videos-complete.plan.md`
**Authorization:** Owner

**Description:** Fecha o upload com a lista de partes do cliente, verifica o que chegou ao storage e enfileira o processamento, de forma segura a repetições.

**Technical actions:**

1. Registrar `BullModule.forRootAsync` em `AppModule` e `BullModule.registerQueue` em `VideosModule` (per `phase-03-videos/TD-01`)
2. Criar `src/videos/dto/complete-video.dto.ts` e `src/videos/part-verification.util.ts`, que compara partes 1..N, ETags sem as aspas e soma com `declared_size`, além de `UploadPartsMismatchException` (`UPLOAD_PARTS_MISMATCH`) (per `phase-03-videos/TD-02`)
3. Criar `VideosService.complete`, seguindo os passos 1 a 4 do `**Behavior:**` em `### API Contracts → POST /videos/{publicId}/complete` (per `phase-03-videos/TD-02`)
4. Enfileirar `process-video` com `jobId` igual a `id` e as opções de `### Events/Messages`, sem remoção automática do job, e gravar `processing` só se `status` ainda for `draft` (per `phase-03-videos/TD-09`, `phase-03-videos/TD-10`)
5. Acrescentar `@Post(':publicId/complete')` com `@HttpCode(200)` a `VideosController`, com as anotações OpenAPI (per `openapi-docs-nestjs/TD-01`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `part-verification.util` | Unit: partes faltantes, ETag divergente, soma diferente, aspas | `src/videos/part-verification.util.spec.ts` |
| `VideosService` | Unit: ramos do `complete`, inclusive soma acima de 10 GiB | `src/videos/videos.service.spec.ts` |
| `VideosService` | Integration: Postgres, Redis e MinIO reais; o teste que enfileira espera o `video-worker` do Compose, e nenhum consumidor novo sobe; inclui `ready` gravado antes da gravação de `processing` | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.8 — worker real consumindo e gravando falhas; SI-03.12 — upload em andamento

**Acceptance criteria:**

- `POST /videos/{publicId}/complete` com todas as partes corretas retorna `200`, e o `GET` do vídeo passa a mostrar `processing` e depois `ready`
- Lista sem uma parte, com `etag` divergente, ou soma diferente de `declared_size` retorna `409` com `error: "UPLOAD_PARTS_MISMATCH"`, e `GET /videos/{publicId}/parts` continua respondendo `200`
- Soma das partes acima de 10737418240 bytes retorna `413` com `error: "VIDEO_TOO_LARGE"`, e o upload é abortado
- Com `status` em `processing`, `ready` ou `error`, repetir a chamada retorna `200` com o estado atual, sem acessar o storage
- Com `status` em `draft`, multipart já fechado e objeto final com o tamanho declarado, repetir a chamada enfileira o job e grava `processing`
- Com `status` em `draft`, `NoSuchUpload` e sem o objeto final, a chamada retorna `409` com `error: "UPLOAD_NOT_FOUND"`
- Repetir a chamada não cria um segundo job para o mesmo vídeo
- Um `ready` gravado pelo worker antes da gravação de `processing` não é sobrescrito
- Chamada de outro usuário retorna `404` com `error: "VIDEO_NOT_FOUND"`; sem token retorna `401`; com `parts` vazio retorna `400` com `error: "VALIDATION_ERROR"`

---

### SI-03.14 — Endpoint GET /videos/{publicId}/stream

**Route:** GET /videos/{publicId}/stream
**Test Specs:** see `nestjs-project/specs/videos-stream.plan.md`
**Authorization:** Owner

**Description:** Entrega ao dono uma URL de leitura para reprodução progressiva, sem passar os bytes pela API.

**Technical actions:**

1. Criar `src/videos/dto/video-url-response.dto.ts` e `VideoNotReadyException` (`VIDEO_NOT_READY`), conforme `### API Contracts → GET /videos/{publicId}/stream`
2. Criar `VideosService.getStreamUrl`, que exige `status` igual a `ready` e assina o `GetObject` pelo endpoint público, com validade de 6h (per `phase-03-videos/TD-08`)
3. Acrescentar `@Get(':publicId/stream')` a `VideosController`, com as anotações OpenAPI (per `openapi-docs-nestjs/TD-01`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService` | Unit: `status` diferente de `ready` | `src/videos/videos.service.spec.ts` |
| `VideosService` | Integration: URL devolvida responde a `Range` no MinIO real | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.10 — checagem de dono e recurso do vídeo

**Acceptance criteria:**

- `GET /videos/{publicId}/stream` com vídeo em `ready` retorna `200` com `url` e `expires_at` cerca de 6h à frente
- `GET` na `url` com `Range: bytes=0-1023` responde `206` com `Content-Range`, e o `Content-Type` é o informado em `POST /videos`
- Vídeo em `draft`, `processing` ou `error` retorna `409` com `error: "VIDEO_NOT_READY"`
- Chamada de outro usuário retorna `404` com `error: "VIDEO_NOT_FOUND"`, e chamada sem token retorna `401`

---

### SI-03.15 — Endpoint GET /videos/{publicId}/download

**Route:** GET /videos/{publicId}/download
**Test Specs:** see `nestjs-project/specs/videos-download.plan.md`
**Authorization:** Owner

**Description:** Entrega ao dono uma URL de download com o nome original do arquivo, sem que o nome quebre o header.

**Technical actions:**

1. Criar `src/videos/content-disposition.util.ts`, que monta `attachment` com `filename` em ASCII, sem aspas e sem quebras de linha, e `filename*=UTF-8''` com `original_filename` codificado (per `### API Contracts → GET /videos/{publicId}/download`)
2. Criar `VideosService.getDownloadUrl`, que exige `status` igual a `ready` e assina o `GetObject` com `ResponseContentDisposition` (per `phase-03-videos/TD-08`)
3. Acrescentar `@Get(':publicId/download')` a `VideosController`, com as anotações OpenAPI (per `openapi-docs-nestjs/TD-01`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `content-disposition.util` | Unit: aspas, quebra de linha, acentos e ponto e vírgula | `src/videos/content-disposition.util.spec.ts` |
| `VideosService` | Integration: header devolvido pelo MinIO real | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.14 — DTO de URL e `VIDEO_NOT_READY`

**Acceptance criteria:**

- `GET /videos/{publicId}/download` com vídeo em `ready` retorna `200` com `url` e `expires_at`
- `GET` na `url` responde com `Content-Disposition` começando por `attachment` e trazendo o nome original
- Um `original_filename` com aspas, quebra de linha e acentos gera um header válido, e o `filename*` decodificado preserva os acentos
- Vídeo fora de `ready` retorna `409` com `error: "VIDEO_NOT_READY"`
- Chamada de outro usuário retorna `404` com `error: "VIDEO_NOT_FOUND"`, e chamada sem token retorna `401`

---

### SI-03.16 — Prova do fluxo completo com infra real

**Description:** Prova o caminho inteiro, do pré-cadastro à reprodução, com Postgres, Redis, MinIO e o `video-worker` do Compose, sem mocks.

**Technical actions:**

1. Criar `test/videos-flow.e2e-spec.ts` sobre `AppModule`, reproduzindo a config global de `main.ts`, com vídeo acima de 16 MiB gerado por `ffmpeg -f lavfi` e `PUT` de cada parte por `src/test/presigned-request.ts`
2. Percorrer o fluxo válido: `POST /videos`, `parts/sign`, `PUT` das partes, `complete` e polling em `GET /videos/{publicId}` até `ready`, seguido de stream, download e thumbnail
3. Percorrer o fluxo inválido: arquivo de texto enviado como vídeo, até `error`, e conferir o original no storage
4. Esperar o `status` final antes de `cleanAllTables`, para o worker não processar linha apagada, e não subir nenhum consumidor da fila no teste

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Fluxo de vídeo | E2E: todas as camadas reais, com o `video-worker` do Compose consumindo | `test/videos-flow.e2e-spec.ts` |

**Dependencies:** SI-03.13 — upload e fila; SI-03.15 — stream e download

**Acceptance criteria:**

- Um vídeo acima de 16 MiB, enviado em mais de uma parte, passa por `draft`, `processing` e `ready`, com duração e `thumbnail_url` preenchidas
- Os bytes lidos pela URL de download são iguais aos do arquivo enviado
- `GET` na URL de stream com `Range` responde `206`
- `GET` na URL de download responde com `Content-Disposition: attachment`
- `GET` sem autenticação na `thumbnail_url` responde `200`, e a listagem do bucket de thumbnails responde `403`
- Um arquivo inválido termina em `error`, e o objeto original continua no storage
- `GET /videos/{publicId}` de outro usuário responde `404` durante todo o fluxo
- Durante o fluxo, a fila `video-processing` tem exatamente um worker conectado

---

### SI-03.17 — Documentação e contrato OpenAPI

**Description:** Deixa a documentação do repositório e o contrato exportado iguais ao que a fase entrega.

**Technical actions:**

1. Atualizar o `CLAUDE.md` raiz: tirar o `TBD` da Message Queue, indicando BullMQ com Redis, e descrever na API o upload por URL pré-assinada (per `phase-03-videos/TD-01`, `phase-03-videos/TD-02`)
2. Atualizar `nestjs-project/CLAUDE.md` com a seção de vídeos, os serviços `redis`, `minio` e `video-worker`, e o fato de o worker subir sozinho no `docker compose up` (per `phase-03-videos/TD-05`)
3. Reexportar `openapi.json` com `docker compose exec nestjs-api npm run openapi:export`, exigido por `.claude/rules/nestjs-controllers.md` (per `openapi-docs-nestjs/TD-02`)
4. Trocar o `TBD` da linha 13 de `docs/diagrams/software-arch.mermaid` (Message Queue) por BullMQ com Redis (per `phase-03-videos/TD-01`)

**Tests:** _(empty — documentação e artefato gerado; conferidos pelos critérios de aceite)_

**Dependencies:** SI-03.15 — todos os endpoints existem; SI-03.16 — fluxo provado

**Acceptance criteria:**

- `docs/diagrams/software-arch.mermaid` mostra a Message Queue como BullMQ com Redis, sem `TBD`
- O `CLAUDE.md` raiz não traz mais `TBD` na Message Queue
- `nestjs-project/CLAUDE.md` lista `redis`, `minio` e `video-worker` entre os serviços
- `openapi.json` traz os sete endpoints de `### API Contracts`, cada um com as respostas de erro do contrato

---

## Technical Specifications

### Data Model

#### Video

Tabela `videos`.

| Field | Type | Constraints | Notes |
|-------|------|-------------|-------|
| id | uuid | PK, generated | UUID interno, gerado na aplicação antes do `CreateMultipartUpload`, porque a chave de storage depende dele. É o `jobId` da fila e só aparece na API dentro de `thumbnail_url` *(per phase-03-videos/TD-03, phase-03-videos/TD-09)* |
| public_id | varchar(11) | unique, not null | Identificador da URL única, imutável: `randomBytes(8).toString('base64url')`, com nova tentativa em colisão `23505` *(per phase-03-videos/TD-07)* |
| channel_id | uuid | FK → channels.id, not null | Canal dono do vídeo |
| title | varchar(255) | not null | Preenchido no pré-cadastro com `original_filename`. A edição é da Fase 04 |
| status | enum (`draft`, `processing`, `ready`, `error`) | not null, default `draft` | Coluna única do ciclo: `draft` no `POST /videos`; `processing` no `complete`; `ready` ou `error` no worker *(per phase-03-videos/TD-09)* |
| original_filename | varchar(255) | not null | Nome original do arquivo. Fora das chaves de storage; usado no `Content-Disposition` do download *(per phase-03-videos/TD-03, phase-03-videos/TD-08)* |
| declared_size | bigint | not null | Tamanho declarado em bytes, usado no limite de 10 GiB e na verificação do `complete` *(per phase-03-videos/TD-02)* |
| upload_id | text | not null | Id do multipart. Fica só no banco e não aparece na API *(per phase-03-videos/TD-02)* |
| source_key | varchar(255) | not null | `{videoId}/source` no bucket de vídeos *(per phase-03-videos/TD-03)* |
| thumbnail_key | varchar(255) | nullable | `{videoId}/thumbnail.jpg` no bucket de thumbnails, gravado junto com `ready` *(per phase-03-videos/TD-03, phase-03-videos/TD-09)* |
| duration | double precision | nullable | Duração em segundos, gravada junto com `ready` *(per phase-03-videos/TD-06)* |
| width | integer | nullable | Largura em pixels *(per phase-03-videos/TD-06)* |
| height | integer | nullable | Altura em pixels *(per phase-03-videos/TD-06)* |
| video_codec | varchar(64) | nullable | Codec de vídeo *(per phase-03-videos/TD-06)* |
| audio_codec | varchar(64) | nullable | Codec de áudio; nulo em vídeo sem áudio *(per phase-03-videos/TD-06)* |
| bitrate | bigint | nullable | Bits por segundo *(per phase-03-videos/TD-06)* |
| container | varchar(255) | nullable | Formato do container *(per phase-03-videos/TD-06)* |
| created_at | timestamp | not null, auto-generated | |
| updated_at | timestamp | not null, auto-generated | |

**Relations:** `Video` → `Channel` (many-to-one, owning side via `channel_id`); `Channel` → `Video` (one-to-many, nova propriedade `videos`)
**Indexes:** `(public_id)` — unique
**Migration:** `<timestamp>-CreateVideos.ts`, gerada pela CLI do TypeORM

### API Contracts

Todos os endpoints exigem `Authorization: Bearer <access_token>`. `{publicId}` é o valor de `public_id`. As URLs pré-assinadas destinadas ao cliente usam `S3_PUBLIC_ENDPOINT` *(per phase-03-videos/TD-03)*. Os nomes de campo seguem snake_case, como o resto da API: `expires_at` e, no JSON, `etag`, com o header HTTP mantido como `ETag` *(per phase-03-videos/TD-02, phase-03-videos/TD-08)*.

#### POST /videos (SI-03.9)

**Request headers:**
- Authorization: Bearer <access_token>
- Content-Type: application/json

**Request body:**
- original_filename: string, required — 1 a 255 caracteres
- declared_size: integer, required — bytes, mínimo 1
- content_type: string, required — 1 a 255 caracteres; gravado no `CreateMultipartUpload` *(per phase-03-videos/TD-08)*

**Response 201:**
- public_id: string (11 caracteres)
- title: string
- status: string — `draft`
- original_filename: string
- declared_size: integer
- part_size: integer — 16777216 (16 MiB) *(per phase-03-videos/TD-02)*
- part_count: integer — teto de `declared_size` / `part_size`
- created_at: string (ISO-8601)
- updated_at: string (ISO-8601)

**Behavior:**
1. Rejeita `declared_size` acima de 10737418240 bytes *(per phase-03-videos/TD-02)*.
2. Gera `id` e abre o `CreateMultipartUpload` em `{videoId}/source`, com o `Content-Type` recebido *(per phase-03-videos/TD-03, phase-03-videos/TD-08)*.
3. Grava o vídeo em `draft`, no canal do usuário autenticado, com `upload_id`, gerando novo `public_id` em colisão `23505` *(per phase-03-videos/TD-07, phase-03-videos/TD-09)*.

**Error responses:**
- 413 VIDEO_TOO_LARGE: quando `declared_size` excede 10 GiB
- 400 validation error: quando o corpo falha na validação
- 401 Unauthorized: token de acesso ausente ou inválido

---

#### POST /videos/{publicId}/parts/sign (SI-03.11)

**Request headers:**
- Authorization: Bearer <access_token>
- Content-Type: application/json

**Request body:**
- part_numbers: integer[], required — 1 a 640 itens, sem repetição, cada um maior ou igual a 1

**Response 200:**
- parts: array de `{ part_number: integer, url: string }` — o cliente faz `PUT` de cada parte na `url` e guarda o header `ETag` da resposta *(per phase-03-videos/TD-02)*
- expires_at: string (ISO-8601) — validade de 1h *(per phase-03-videos/TD-02)*

**Error responses:**
- 400 UPLOAD_PART_OUT_OF_RANGE: quando um número excede `part_count`
- 404 VIDEO_NOT_FOUND: quando o vídeo não existe ou é de outro canal
- 409 VIDEO_UPLOAD_CLOSED: quando `status` não é `draft`
- 400 validation error: quando o corpo falha na validação
- 401 Unauthorized: token de acesso ausente ou inválido

---

#### GET /videos/{publicId}/parts (SI-03.12)

**Request headers:**
- Authorization: Bearer <access_token>

**Response 200:**
- part_size: integer
- part_count: integer
- uploaded_parts: array de `{ part_number: integer, etag: string }`
- missing_part_numbers: integer[]

**Behavior:**
1. Consulta o `ListParts`, com paginação, para informar ao cliente o que falta enviar *(per phase-03-videos/TD-02, phase-03-videos/TD-09)*.
2. `uploaded_parts` traz o `etag` para que um cliente que perdeu a própria lista consiga retomar. A verificação de partes 1..N no `complete` continua valendo.

**Error responses:**
- 404 VIDEO_NOT_FOUND: quando o vídeo não existe ou é de outro canal
- 409 VIDEO_UPLOAD_CLOSED: quando `status` não é `draft`
- 409 UPLOAD_NOT_FOUND: quando o storage responde `NoSuchUpload`
- 401 Unauthorized: token de acesso ausente ou inválido

---

#### POST /videos/{publicId}/complete (SI-03.13)

**Request headers:**
- Authorization: Bearer <access_token>
- Content-Type: application/json

**Request body:**
- parts: array, required — 1 a 640 itens *(per phase-03-videos/TD-02)*
  - part_number: integer, required — maior ou igual a 1
  - etag: string, required — não vazio; valor do header `ETag` recebido no `PUT` da parte

**Response 200:** mesmo recurso de `GET /videos/{publicId}`, com o `status` atual.

**Behavior:**
1. Com `status` em `processing`, `ready` ou `error`: responde o estado atual, sem chamar o storage, o que mantém a repetição segura *(per phase-03-videos/TD-02)*.
2. Com `status` em `draft`: consulta o `ListParts`, com paginação, só para verificar *(per phase-03-videos/TD-02)*.
   - Soma acima de 10 GiB: chama `AbortMultipartUpload` e responde 413.
   - Divergência em partes 1..N, em ETags ou na soma, que precisa ser igual a `declared_size`: responde 409 sem abortar, para o cliente reenviar. A comparação de ETags ignora as aspas do valor. N é `part_count`.
3. Fecha com `CompleteMultipartUpload` usando a lista do cliente, em ordem crescente de `part_number`.
4. Se o passo 2 ou 3 receber `NoSuchUpload`: confere o objeto final com `HeadObject`. Existindo com o tamanho `declared_size`, segue para o passo 5; caso contrário, responde 409 UPLOAD_NOT_FOUND *(per phase-03-videos/TD-02)*.
5. Enfileira `process-video` com `jobId = id` e só então grava `processing`, apenas se `status` ainda for `draft`, para não sobrescrever um `ready` ou `error` que o worker já tenha gravado *(per phase-03-videos/TD-09)*.

**Error responses:**
- 413 VIDEO_TOO_LARGE: quando a soma das partes excede 10 GiB
- 409 UPLOAD_PARTS_MISMATCH: quando a verificação do passo 2 diverge
- 409 UPLOAD_NOT_FOUND: quando há `NoSuchUpload` e o objeto final não existe com o tamanho declarado
- 404 VIDEO_NOT_FOUND: quando o vídeo não existe ou é de outro canal
- 400 validation error: quando o corpo falha na validação
- 401 Unauthorized: token de acesso ausente ou inválido

---

#### GET /videos/{publicId} (SI-03.10)

**Request headers:**
- Authorization: Bearer <access_token>

**Response 200:** recurso do vídeo, usado para consultar o `status` por polling *(per phase-03-videos/TD-09)*.
- public_id: string
- title: string
- status: string — `draft`, `processing`, `ready` ou `error`
- original_filename: string
- declared_size: integer
- duration: number | null
- width: integer | null
- height: integer | null
- video_codec: string | null
- audio_codec: string | null
- bitrate: integer | null
- container: string | null
- thumbnail_url: string | null — `{S3_PUBLIC_ENDPOINT}/{S3_BUCKET_THUMBNAILS}/{thumbnail_key}` *(per phase-03-videos/TD-03)*
- created_at: string (ISO-8601)
- updated_at: string (ISO-8601)

**Error responses:**
- 404 VIDEO_NOT_FOUND: quando o vídeo não existe ou é de outro canal
- 401 Unauthorized: token de acesso ausente ou inválido

---

#### GET /videos/{publicId}/stream (SI-03.14)

**Request headers:**
- Authorization: Bearer <access_token>

**Response 200:** `{ url, expires_at }` *(per phase-03-videos/TD-08)*
- url: string — URL pré-assinada de `GetObject`; o storage atende por HTTP Range, sem exigir download completo
- expires_at: string (ISO-8601) — validade de 6h; ao receber 403 do storage, o cliente pede outra URL

**Error responses:**
- 409 VIDEO_NOT_READY: quando `status` não é `ready`
- 404 VIDEO_NOT_FOUND: quando o vídeo não existe ou é de outro canal
- 401 Unauthorized: token de acesso ausente ou inválido

---

#### GET /videos/{publicId}/download (SI-03.15)

**Request headers:**
- Authorization: Bearer <access_token>

**Response 200:** `{ url, expires_at }` *(per phase-03-videos/TD-08)*
- url: string — URL pré-assinada de `GetObject` com `ResponseContentDisposition: attachment` e `original_filename` codificado, para aspas, quebras de linha e acentos não quebrarem o header
- expires_at: string (ISO-8601) — validade de 6h

**Error responses:**
- 409 VIDEO_NOT_READY: quando `status` não é `ready`
- 404 VIDEO_NOT_FOUND: quando o vídeo não existe ou é de outro canal
- 401 Unauthorized: token de acesso ausente ou inválido

### Authorization Matrix

| Endpoint | Anonymous | Authenticated | Owner | Notes |
|----------|-----------|---------------|-------|-------|
| POST /videos | ✗ | ✓ | n/a | Cria no canal do próprio usuário |
| POST /videos/{publicId}/parts/sign | ✗ | ✗ | ✓ | |
| GET /videos/{publicId}/parts | ✗ | ✗ | ✓ | |
| POST /videos/{publicId}/complete | ✗ | ✗ | ✓ | |
| GET /videos/{publicId} | ✗ | ✗ | ✓ | |
| GET /videos/{publicId}/stream | ✗ | ✗ | ✓ | Só o dono nesta fase *(per phase-03-videos/TD-08)* |
| GET /videos/{publicId}/download | ✗ | ✗ | ✓ | Só o dono nesta fase *(per phase-03-videos/TD-08)* |

**Owner:** usuário cujo `channels.user_id` é igual ao `sub` do JWT, no canal apontado por `videos.channel_id`. Quem não é o dono recebe 404 VIDEO_NOT_FOUND, como em um vídeo inexistente. A proteção vem do `JwtAuthGuard` global; nenhum endpoint desta fase usa `@Public()`.

### Error Catalog

Formato herdado: `{ statusCode, error, message }`, com o código do catálogo em `error` *(per phase-02-auth/TD-07)*. O 401 vem do `JwtAuthGuard` existente e não entra neste catálogo.

| errorCode | HTTP | Message | Trigger |
|-----------|------|---------|---------|
| VIDEO_TOO_LARGE | 413 | Video exceeds the 10 GiB limit | `POST /videos` com `declared_size` acima do limite, ou `complete` com soma das partes acima do limite, que aborta o upload |
| VIDEO_NOT_FOUND | 404 | Video not found | `public_id` inexistente, ou vídeo de outro canal |
| VIDEO_UPLOAD_CLOSED | 409 | Video upload is already closed | `parts/sign` ou `GET parts` com `status` diferente de `draft` |
| UPLOAD_PART_OUT_OF_RANGE | 400 | Part number is out of range | `parts/sign` com número maior que `part_count` |
| UPLOAD_PARTS_MISMATCH | 409 | Uploaded parts do not match the declared file | `complete` com divergência em partes 1..N, em ETags ou na soma em relação a `declared_size`; o upload continua aberto |
| UPLOAD_NOT_FOUND | 409 | Multipart upload not found | `NoSuchUpload` em `GET parts`, ou no `complete` quando o objeto final não existe com o tamanho declarado |
| VIDEO_NOT_READY | 409 | Video is not ready | `stream` ou `download` com `status` diferente de `ready` *(per phase-03-videos/TD-08)* |

### Events/Messages

Fila `video-processing`, no serviço `redis` do Compose *(per phase-03-videos/TD-01)*.

#### process-video

**Payload:**

```json
{ "videoId": "uuid" }
```

**Producer:** `VideosService`, na API, via `BullModule.registerQueue` (per `phase-03-videos/TD-01`)
**Consumer:** `VideoProcessor`, com `@Processor` + `WorkerHost`, no serviço `video-worker` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-05`)
**Trigger:** `POST /videos/{publicId}/complete`, depois de fechar o multipart, com `jobId = videoId`; um `add` repetido é ignorado (per `phase-03-videos/TD-09`)
**Job options:** `attempts: 3`, `backoff: { type: 'exponential', delay: 30000 }`, sem remoção automática do job (per `phase-03-videos/TD-10`)
**Processing:** assina a leitura de `source_key` com o endpoint interno, roda `ffprobe` e `ffmpeg` por `spawn` e envia a thumbnail ao storage. Grava `ready` junto com metadados e `thumbnail_key` (per `phase-03-videos/TD-03`, `phase-03-videos/TD-06`, `phase-03-videos/TD-09`)
**Permanent failure:** `ffprobe` rejeita o arquivo ou não há stream de vídeo: lança `UnrecoverableError`, sem repetir (per `phase-03-videos/TD-10`)
**Delivery semantics:** at-least-once; o job é idempotente, porque reescreve a mesma chave de thumbnail e a mesma linha no banco (per `phase-03-videos/TD-10`)

#### failed

**Payload:**

```json
{ "jobId": "uuid", "failedReason": "string" }
```

**Producer:** BullMQ, no stream de eventos da fila `video-processing`, lido por `QueueEvents` (per `phase-03-videos/TD-10`)
**Consumer:** `VideoEventsListener`, com `@QueueEventsListener` usando `lastEventId: '0-0'` + `@OnQueueEvent('failed')`, no mesmo processo do worker, junto do processor (per `phase-03-videos/TD-05`, `phase-03-videos/TD-09`, `phase-03-videos/TD-10`)
**Trigger:** job movido para `failed`: tentativas esgotadas, `UnrecoverableError` ou job travado acima do limite (per `phase-03-videos/TD-10`)
**Effect:** grava `error` só `WHERE id = jobId AND status IN ('draft', 'processing')`, sem `failure_code`, e mantém o arquivo original (per `phase-03-videos/TD-10`). O `draft` entra porque o worker pode falhar antes de a API gravar `processing`, e essa gravação já é condicional
**Delivery semantics:** o stream de `QueueEvents` não perde eventos em desconexões e é aparado em cerca de 10.000 eventos. O listener usa `lastEventId: '0-0'` para reler os eventos retidos ao subir, de modo que um `failed` emitido com o processo fora do ar não se perca. Reler é seguro porque o `jobId` é único por vídeo, não há reprocessamento nesta fase e a gravação é condicional. A confirmação da opção `lastEventId` no pacote Node fica para a implementação, em SI-03.8 (per `phase-03-videos/TD-10`)

---

## Dependency Map

```
SI-03.1 (root)
├── SI-03.2 — depends on SI-03.1 (as chaves apontam para os serviços do Compose)
│   └── SI-03.4 — depends on SI-03.1, SI-03.2 (MinIO em execução, config e SDK)
│       ├── SI-03.5 — depends on SI-03.1, SI-03.2, SI-03.3, SI-03.4 (worker precisa de config, entidade e storage)
│       │   ├── SI-03.7 — depends on SI-03.5, SI-03.6 (processor no WorkerModule, usando o FFmpeg)
│       │   │   └── SI-03.8 — depends on SI-03.7 (listener usa VideoProcessingService)
│       │   │       └── SI-03.13 — depends on SI-03.8, SI-03.12 (espera o worker real; upload em andamento)
│       │   │           └── SI-03.16 — depends on SI-03.13, SI-03.15 (fluxo completo)
│       │   │               └── SI-03.17 — depends on SI-03.15, SI-03.16 (documenta e exporta o que foi provado)
│       │   └── SI-03.9 — depends on SI-03.3, SI-03.4, SI-03.5 (rascunho, multipart e constantes)
│       │       └── SI-03.10 — depends on SI-03.9 (módulo, serviço e controller)
│       │           ├── SI-03.11 — depends on SI-03.10 (checagem de dono)
│       │           │   └── SI-03.12 — depends on SI-03.11 (partes assinadas) → SI-03.13
│       │           └── SI-03.14 — depends on SI-03.10 (checagem de dono e recurso)
│       │               └── SI-03.15 — depends on SI-03.14 (DTO de URL e VIDEO_NOT_READY) → SI-03.16, SI-03.17
│       └── SI-03.6 — depends on SI-03.1, SI-03.4 (FFmpeg na imagem e URL pré-assinada) → SI-03.7
SI-03.3 (root, independent) → SI-03.5, SI-03.9
```

---

## Deliverables

- [ ] SI-03.1 — Infra: Redis, MinIO e FFmpeg no Compose
- [ ] SI-03.2 — Infra: dependências, configs `queue` e `storage`, schema Joi e `.env.example`
- [ ] SI-03.3 — Entidade `Video` e migration `CreateVideos`
- [ ] SI-03.4 — Serviço de storage: multipart, assinatura e buckets
- [ ] SI-03.5 — Infra: worker em processo próprio
- [ ] SI-03.6 — Extração de metadados e thumbnail com FFmpeg
- [ ] SI-03.7 — Processamento do vídeo no worker
- [ ] SI-03.8 — Registro da falha no `status`
- [ ] SI-03.9 — Endpoint POST /videos
- [ ] SI-03.10 — Endpoint GET /videos/{publicId}
- [ ] SI-03.11 — Endpoint POST /videos/{publicId}/parts/sign
- [ ] SI-03.12 — Endpoint GET /videos/{publicId}/parts
- [ ] SI-03.13 — Endpoint POST /videos/{publicId}/complete
- [ ] SI-03.14 — Endpoint GET /videos/{publicId}/stream
- [ ] SI-03.15 — Endpoint GET /videos/{publicId}/download
- [ ] SI-03.16 — Prova do fluxo completo com infra real
- [ ] SI-03.17 — Documentação e contrato OpenAPI

**Full test suites:**

- [ ] Backend tests pass (`cd nestjs-project && docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] E2E tests pass (`cd nestjs-project && docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type/compilation checks pass (`cd nestjs-project && docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passes (`cd nestjs-project && docker compose exec nestjs-api npm run lint`)
- [ ] Project builds successfully (`cd nestjs-project && docker compose exec nestjs-api npm run build`)
