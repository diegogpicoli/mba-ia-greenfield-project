---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.12
target_file: test/videos-parts-list.e2e-spec.ts
---

# GET /videos/{publicId}/parts — Test Plan

## Application Overview

`GET /videos/{publicId}/parts` permite retomar o upload. Consulta o `ListParts` e devolve o que já chegou ao storage, com o `etag` de cada parte, e o que falta enviar. Só funciona com o vídeo em `draft`.

## Test Scenarios

### 1. GET /videos/{publicId}/parts

**Setup:** `beforeAll` sobe `Test.createTestingModule({ imports: [AppModule] }).compile()` e reproduz a config global de `main.ts`. `beforeEach` limpa `ThrottlerStorage`, chama `cleanAllTables`, cria dois usuários autenticados pelos endpoints de `auth` e, com o primeiro, um vídeo de `declared_size` 20971520 (`part_count` 2). As URLs assinadas são chamadas por `src/test/presigned-request.ts`. Postgres, Redis e MinIO são os do Compose, sem mocks, e nenhum consumidor da fila sobe no teste.

#### 1.1. progresso-sem-partes

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-06T16:10:48Z

**Steps:**
  1. GET /videos/{publicId}/parts com o token do dono, sem nenhuma parte enviada
    - expect: status 200
    - expect: `part_size` igual a 16777216 e `part_count` igual a 2
    - expect: `uploaded_parts` vazio e `missing_part_numbers` igual a `[1, 2]`

#### 1.2. progresso-depois-da-primeira-parte

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-06T16:10:48Z

**Steps:**
  1. Assinar a parte 1 e fazer PUT de 16 MiB na URL devolvida
    - expect: status 200 e header `ETag` presente
  2. GET /videos/{publicId}/parts com o token do dono
    - expect: status 200
    - expect: `uploaded_parts` com um item, de `part_number` 1 e `etag` preenchido
    - expect: `missing_part_numbers` igual a `[2]`

#### 1.3. rejeita-video-fora-de-draft

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-06T16:10:48Z

**Steps:**
  1. Gravar no banco `status` igual a `processing`
    - expect: a linha fica atualizada
  2. GET /videos/{publicId}/parts com o token do dono
    - expect: status 409 e `error` igual a `VIDEO_UPLOAD_CLOSED`

#### 1.4. rejeita-upload-abortado

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-06T16:10:48Z

**Steps:**
  1. Abortar o multipart pelo `StorageService`, com o vídeo ainda em `draft`
    - expect: o aborto termina sem erro
  2. GET /videos/{publicId}/parts com o token do dono
    - expect: status 409 e `error` igual a `UPLOAD_NOT_FOUND`

#### 1.5. outro-usuario-e-sem-token

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-06T16:10:48Z

**Steps:**
  1. GET /videos/{publicId}/parts com o token do outro usuário
    - expect: status 404 e `error` igual a `VIDEO_NOT_FOUND`
  2. GET /videos/{publicId}/parts sem o header `Authorization`
    - expect: status 401
