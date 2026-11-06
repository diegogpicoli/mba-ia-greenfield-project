# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 3/17 completed

### SI-03.1 — Infra: Redis, MinIO e FFmpeg no Compose
- **Status:** completed
- **Tests:** no tests
- **Observations:**
  - Versões em execução: Redis 8.8.4 e FFmpeg 5.1.9, do apt do Debian 12 da imagem `node:25.6.0-slim`. É uma versão de 2022 em diante; `library-refs.md` usa a documentação atual do site, então as próximas SIs devem conferir as opções nesta versão.
  - `minio --version` responde `DEVELOPMENT.GOGET`, porque `go install` não grava a versão. O commit foi provado pelos metadados do binário: `go version -m` mostra `github.com/minio/minio v0.0.0-20251015172955-9e49d5e7a648`.
  - O efeito de `MINIO_API_STALE_UPLOADS_EXPIRY=168h` não foi provado: o valor chega ao container e os logs não têm erro, mas a expiração em 7 dias não é observável aqui.
  - Apareceu `nestjs-project/nul`, arquivo vazio e não versionado, durante a verificação desta SI, sem origem identificada. Foi removido antes do commit.

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
  - A edição manual do plano o deixa mais novo que as specs. Um aviso de spec STALE no preflight do `/implement` por causa dela é falso positivo: as specs não mudaram.
  - A spec de migrations agora tem dois testes de reversão, de `CreateVideos` e de `CreateAuthTokens`, para não perder a cobertura que já existia.
  - Avisos do Node durante os testes, sem falha: `--localstorage-file` e o deprecation de `client.query()` do `pg`.

### SI-03.4 — Serviço de storage: multipart, assinatura e buckets
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.5 — Infra: worker em processo próprio
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

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
