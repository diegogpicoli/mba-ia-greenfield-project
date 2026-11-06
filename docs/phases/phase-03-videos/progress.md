# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 5/17 completed

### SI-03.1 — Infra: Redis, MinIO e FFmpeg no Compose
- **Status:** completed
- **Tests:** no tests
- **Observations:**
  - Versões em execução: Redis 8.8.4 e FFmpeg 5.1.9, do apt do Debian 12 da imagem `node:25.6.0-slim`. É uma versão de 2022 em diante; `library-refs.md` usa a documentação atual do site, então as próximas SIs devem conferir as opções nesta versão.
  - `minio --version` responde `DEVELOPMENT.GOGET`, porque `go install` não grava a versão. O commit foi provado pelos metadados do binário: `go version -m` mostra `github.com/minio/minio v0.0.0-20251015172955-9e49d5e7a648`.
  - O efeito de `MINIO_API_STALE_UPLOADS_EXPIRY=168h` não foi provado: o valor chega ao container e os logs não têm erro, mas a expiração em 7 dias não é observável aqui.

### SI-03.2 — Infra: dependências, configs `queue` e `storage`, schema Joi e `.env.example`
- **Status:** completed
- **Tests:** 17 passing
- **Observations:**
  - As nove chaves são obrigatórias sem default, então um `.env` local antigo impede a aplicação de subir até receber as chaves do `.env.example`. O `.env` desta máquina já foi atualizado, e ele não é versionado.
  - A prova de boot leva de 40 a 85 s, porque carregar os módulos pelo bind mount do Windows é lento. Uma primeira tentativa com `timeout 25` foi inconclusiva: o processo morreu antes de validar o schema. Prazos curtos em comandos no container podem dar falso resultado nas próximas SIs.
  - `npm audit` aponta 65 vulnerabilidades (3 críticas). Nenhuma das cinco libs novas aparece pelo nome como pacote afetado; dependências transitivas não foram analisadas, e a correção está fora do escopo desta SI.

### SI-03.3 — Entidade `Video` e migration `CreateVideos`
- **Status:** completed
- **Tests:** 17 passing (16 da SI + 1 e2e de `AppModule`); as 10 specs em que `Video` entrou na lista de entidades também passam (79 testes em 12 suítes, antes de criar o módulo)
- **Observations:**
  - **Mudança no plano:** o `VideosModule` mínimo foi criado nesta SI, e não na SI-03.9. Motivo: com `Channel.videos` e `autoLoadEntities`, o `AppModule` falhava com `Entity metadata for Channel#videos was not found` até alguém registrar `Video`, o que deixaria aplicação e e2e quebrados da SI-03.3 à SI-03.8. `.claude/rules/nestjs-modules.md` manda registrar toda entidade no módulo dono, e a ordem do plano estava errada. A SI-03.3 ganhou a ação e o critério de aceite, juntando os ajustes de teste em uma ação para manter o limite de 5, e a ação 5 da SI-03.9 passou a ampliar o módulo.
  - A spec de migrations agora tem dois testes de reversão, de `CreateVideos` e de `CreateAuthTokens`, para não perder a cobertura que já existia.
  - Avisos do Node durante os testes, sem falha: `--localstorage-file` e o deprecation de `client.query()` do `pg`.

### SI-03.4 — Serviço de storage: multipart, assinatura e buckets
- **Status:** completed
- **Tests:** 14 passing (13 de integração contra o MinIO real + 1 de compilação do módulo)
- **Observations:**
  - `ListParts` difere da AWS: sem `max-parts`, o MinIO devolveu 1001 partes em uma só resposta, com `IsTruncated=false`, e sua documentação indica até 10.000 por resposta. A AWS devolve até 1.000. O serviço envia `MaxParts: 1000`, para a paginação funcionar igual nos dois.
  - `AbortMultipartUpload` difere dos erros declarados no SDK: repetir o abort de um upload já abortado responde `204` no MinIO, e um `uploadId` que nunca existiu responde `NoSuchUpload`. `ListParts` e `CompleteMultipartUpload` depois do abort respondem `NoSuchUpload`. A SI-03.13 não deve usar o abort para descobrir se o upload ainda existe.
  - `requestChecksumCalculation` foi medido nas URLs de `UploadPart`: `WHEN_SUPPORTED` acrescenta `x-amz-checksum-crc32` e `x-amz-sdk-checksum-algorithm`, e `WHEN_REQUIRED` não acrescenta nenhum dos dois.
  - As URLs de `GetObject` carregam `x-amz-checksum-mode`, por causa do padrão de `responseChecksumValidation`, que o plano não altera. O MinIO aceita essas URLs e responde `200` e `206`.
  - A validade do `GetObject` interno, usado pelo worker, é de 1h. O plano não a define; o valor é suficiente porque a URL é assinada logo antes de `ffprobe` e `ffmpeg`.
  - Os métodos de assinatura devolvem `{ url, expiresAt }`, para `expires_at` vir da mesma validade usada na assinatura. `headObject` devolve `null` quando o objeto não existe, para a SI-03.13 decidir a resposta.
  - O plano passou a prever `@SkipThrottle()` em `VideosController` (SI-03.9), e a SI-03.10 e a spec `videos-get.plan.md` ganharam o cenário correspondente, porque o `ThrottlerGuard` global, com 10 requisições por minuto, devolveria `429` ao polling de `status`.
  - Não provados: a expiração real das URLs, já que os testes conferem `X-Amz-Expires` e `expiresAt` sem esperar o prazo; e o `PUT` a partir de um navegador, que depende de CORS e fica para a fase com tela. `PUT` e `GET` com `Range` em URLs assinadas para `localhost:9000` foram conferidos com `curl` a partir do host.

### SI-03.5 — Infra: worker em processo próprio
- **Status:** completed
- **Tests:** 1 passing
- **Observations:**
  - **Para a documentação da SI-03.17:** mudança no código do worker exige `docker compose restart video-worker`. O bind mount é `9p`, e nele nem `fs.watch` nem `nest start --watch` perceberam edição, feita no host ou dentro do container, mesmo com o compilador já em "Watching for file changes". O `start:dev` da API usa o mesmo mount, então deve ter a mesma limitação; isso não foi medido na API.
  - `start:worker` não usa `--watch`. Além de não recarregar, o CLI do Nest continua vivo quando o processo do worker morre, e o container nunca sairia para o `restart: unless-stopped` agir. O script compila e faz `exec node dist-worker/worker`, e o `command` faz `exec npm run start:worker`, então a morte do worker encerra o container.
  - O `video-worker` recebe `env_file` com `.env.example` e `.env` opcional, que prevalece. O plano não previa isso: um clone novo não tem `.env`, e a validação Joi exige as chaves. O `nestjs-api` segue dependendo de um `.env` para subir a aplicação.
  - Tempos medidos: primeira subida com `npm install` em volume vazio, de 1 a 2 min; clone novo com imagens em cache, 85 s; volta após a morte do processo, 38 s. Compilar o worker leva cerca de 30 s com o `node_modules` em volume, contra mais de 6 min com o `node_modules` no bind mount. O tempo com imagens construídas do zero não foi medido.
  - `docker compose stop video-worker` termina em 2 s, com `npm error signal SIGTERM` no log e código de saída 1. Isso é o `npm` relatando o sinal, e não uma falha do worker.
  - `dist-worker` saiu de `tsconfig.json` e `tsconfig.build.json`, para os `.d.ts` do worker não entrarem nas compilações da API. `tsconfig.worker.json` inclui só `src/worker.ts` e o que ele importa.
  - `src/worker.module.spec.ts` abre conexão real com `db` e `redis` ao compilar, como `channels.module.spec.ts`, porque o `TypeOrmModule.forRootAsync` conecta na compilação do módulo. O `close()` do Nest não dispara `onModuleInit`, então o teste não sobe consumidor.
  - Não provados: o consumo de jobs e a recuperação de job travado após a queda, porque o processor só chega na SI-03.7. O serviço ainda só registra a fila.

### SI-03.6 — Extração de metadados e thumbnail com FFmpeg
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.7 — Processamento do vídeo no worker
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.8 — Registro da falha no `status`
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.9 — Endpoint POST /videos
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.10 — Endpoint GET /videos/{publicId}
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.11 — Endpoint POST /videos/{publicId}/parts/sign
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.12 — Endpoint GET /videos/{publicId}/parts
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.13 — Endpoint POST /videos/{publicId}/complete
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.14 — Endpoint GET /videos/{publicId}/stream
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.15 — Endpoint GET /videos/{publicId}/download
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.16 — Prova do fluxo completo com infra real
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.17 — Documentação e contrato OpenAPI
- **Status:** pending
- **Tests:** no tests
- **Observations:** none
