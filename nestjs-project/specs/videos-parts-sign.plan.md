---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.11
target_file: test/videos-parts-sign.e2e-spec.ts
---

# POST /videos/{publicId}/parts/sign — Test Plan

## Application Overview

`POST /videos/{publicId}/parts/sign` assina sob demanda as partes do upload, para o cliente enviar os bytes direto ao storage. Só funciona com o vídeo em `draft` e para números dentro de `part_count`. O cliente guarda o header `ETag` de cada `PUT`.

## Test Scenarios

### 1. POST /videos/{publicId}/parts/sign

**Setup:** `beforeAll` sobe `Test.createTestingModule({ imports: [AppModule] }).compile()` e reproduz a config global de `main.ts`. `beforeEach` limpa `ThrottlerStorage`, chama `cleanAllTables`, cria dois usuários autenticados pelos endpoints de `auth` e, com o primeiro, um vídeo de `declared_size` 20971520 (`part_count` 2). As URLs assinadas são chamadas por `src/test/presigned-request.ts`. Postgres, Redis e MinIO são os do Compose, sem mocks, e nenhum consumidor da fila sobe no teste.

#### 1.1. assina-partes-do-rascunho

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-06T16:10:48Z

**Steps:**
  1. POST /videos/{publicId}/parts/sign com o token do dono e `part_numbers` igual a `[1, 2]`
    - expect: status 200
    - expect: `parts` com dois itens, cada um com `part_number` e `url`
    - expect: `expires_at` cerca de 1h à frente

#### 1.2. url-assinada-aceita-put

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-06T16:10:48Z

**Steps:**
  1. POST /videos/{publicId}/parts/sign com `part_numbers` igual a `[1]`
    - expect: status 200
  2. PUT de 16 MiB na `url` devolvida
    - expect: status 200 e header `ETag` presente

#### 1.3. rejeita-numero-acima-de-part-count

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-06T16:10:48Z

**Steps:**
  1. POST /videos/{publicId}/parts/sign com `part_numbers` igual a `[3]`
    - expect: status 400
    - expect: `error` igual a `UPLOAD_PART_OUT_OF_RANGE`

#### 1.4. rejeita-lista-vazia-ou-repetida

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-06T16:10:48Z

**Steps:**
  1. POST /videos/{publicId}/parts/sign com `part_numbers` igual a `[]`
    - expect: status 400 e `error` igual a `VALIDATION_ERROR`
  2. POST /videos/{publicId}/parts/sign com `part_numbers` igual a `[1, 1]`
    - expect: status 400 e `error` igual a `VALIDATION_ERROR`

#### 1.5. rejeita-video-fora-de-draft

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-06T16:10:48Z

**Steps:**
  1. Gravar no banco `status` igual a `processing`
    - expect: a linha fica atualizada
  2. POST /videos/{publicId}/parts/sign com `part_numbers` igual a `[1]`
    - expect: status 409 e `error` igual a `VIDEO_UPLOAD_CLOSED`

#### 1.6. outro-usuario-e-sem-token

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-11-06T16:10:48Z

**Steps:**
  1. POST /videos/{publicId}/parts/sign com o token do outro usuário
    - expect: status 404 e `error` igual a `VIDEO_NOT_FOUND`
  2. POST /videos/{publicId}/parts/sign sem o header `Authorization`
    - expect: status 401
