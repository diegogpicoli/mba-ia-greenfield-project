---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.9
target_file: test/videos-create.e2e-spec.ts
---

# POST /videos — Test Plan

## Application Overview

`POST /videos` inicia o upload de um vídeo de até 10 GiB. A API valida o tamanho declarado, abre o `CreateMultipartUpload` no MinIO e pré-cadastra o vídeo como `draft` no canal do usuário autenticado. O cliente recebe o `public_id` e o plano de partes, e os bytes vão direto ao storage nas etapas seguintes.

## Test Scenarios

### 1. POST /videos

**Setup:** `beforeAll` sobe `Test.createTestingModule({ imports: [AppModule] }).compile()` e reproduz a config global de `main.ts`. `beforeEach` limpa `ThrottlerStorage`, chama `cleanAllTables` e cria um usuário autenticado pelos endpoints de `auth`. Postgres, Redis e MinIO são os do Compose, sem mocks, e nenhum consumidor da fila sobe no teste.

#### 1.1. cria-rascunho-com-plano-de-partes

**Covers AC:** #1, #6
**Source:** auto
**Last sync:** 2026-11-06T12:45:06Z

**Steps:**
  1. POST /videos com token válido e body `{ original_filename: "aula.mp4", declared_size: 20971520, content_type: "video/mp4" }`
    - expect: status 201
    - expect: `public_id` com 11 caracteres, `status` igual a `draft` e `title` igual a `aula.mp4`
    - expect: `part_size` igual a 16777216 e `part_count` igual a 2
    - expect: o corpo não traz `id` nem `upload_id`

#### 1.2. aceita-tamanho-exato-do-limite

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-06T12:45:06Z

**Steps:**
  1. POST /videos com token válido e `declared_size` igual a 10737418240
    - expect: status 201
    - expect: `part_count` igual a 640

#### 1.3. rejeita-um-byte-acima-do-limite

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-06T12:45:06Z

**Steps:**
  1. POST /videos com token válido e `declared_size` igual a 10737418241
    - expect: status 413
    - expect: `error` igual a `VIDEO_TOO_LARGE`
    - expect: nenhuma linha nova em `videos`

#### 1.4. rejeita-sem-content-type

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-06T12:45:06Z

**Steps:**
  1. POST /videos com token válido e body sem `content_type`
    - expect: status 400
    - expect: `error` igual a `VALIDATION_ERROR`

#### 1.5. rejeita-sem-token

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-06T12:45:06Z

**Steps:**
  1. POST /videos com body válido e sem o header `Authorization`
    - expect: status 401

#### 1.6. grava-rascunho-no-canal-com-multipart-aberto

**Covers AC:** #7
**Source:** auto
**Last sync:** 2026-11-06T12:45:06Z

**Steps:**
  1. POST /videos com token válido e body válido
    - expect: status 201
  2. Consultar a linha de `videos` pelo `public_id` devolvido
    - expect: `channel_id` é o canal do usuário autenticado
    - expect: `upload_id` preenchido e `source_key` igual a `{id}/source`
  3. Listar as partes do `upload_id` pelo `StorageService`
    - expect: lista vazia, sem `UPLOAD_NOT_FOUND`
