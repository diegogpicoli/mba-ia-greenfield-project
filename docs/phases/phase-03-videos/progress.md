# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 1/17 completed

### SI-03.1 — Infra: Redis, MinIO e FFmpeg no Compose
- **Status:** completed
- **Tests:** no tests
- **Observations:**
  - Versões em execução: Redis 8.8.4 e FFmpeg 5.1.9, do apt do Debian 12 da imagem `node:25.6.0-slim`. É uma versão de 2022 em diante; `library-refs.md` usa a documentação atual do site, então as próximas SIs devem conferir as opções nesta versão.
  - `minio --version` responde `DEVELOPMENT.GOGET`, porque `go install` não grava a versão. O commit foi provado pelos metadados do binário: `go version -m` mostra `github.com/minio/minio v0.0.0-20251015172955-9e49d5e7a648`.
  - O efeito de `MINIO_API_STALE_UPLOADS_EXPIRY=168h` não foi provado: o valor chega ao container e os logs não têm erro, mas a expiração em 7 dias não é observável aqui.
  - Apareceu `nestjs-project/nul`, arquivo vazio e não versionado, durante a verificação desta SI, sem origem identificada. Foi removido antes do commit.

### SI-03.2 — Infra: dependências, configs `queue` e `storage`, schema Joi e `.env.example`
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.3 — Entidade `Video` e migration `CreateVideos`
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

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
