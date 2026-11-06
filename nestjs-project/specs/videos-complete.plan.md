---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.13
target_file: test/videos-complete.e2e-spec.ts
---

# POST /videos/{publicId}/complete — Test Plan

## Application Overview

`POST /videos/{publicId}/complete` fecha o upload com a lista de `part_number` e `etag` enviada pelo cliente. O `ListParts` só verifica partes 1..N, ETags e soma igual ao tamanho declarado. Depois a API enfileira `process-video` com `jobId` igual ao `id` do vídeo e grava `processing`, apenas se o vídeo ainda estiver em `draft`. Repetir a chamada é seguro.

## Test Scenarios

### 1. POST /videos/{publicId}/complete

**Setup:** `beforeAll` sobe `Test.createTestingModule({ imports: [AppModule] }).compile()` e reproduz a config global de `main.ts`. `beforeEach` limpa `ThrottlerStorage`, espera o `status` final dos vídeos enfileirados no teste anterior, chama `cleanAllTables` e cria dois usuários autenticados pelos endpoints de `auth`. Os vídeos são gerados por `src/test/generate-test-video.ts`, e as URLs assinadas são chamadas por `src/test/presigned-request.ts`. Postgres, Redis e MinIO são os do Compose, sem mocks. O teste que enfileira espera o `video-worker` do Compose, e nenhum consumidor da fila sobe no teste.

#### 1.1. fecha-e-processa

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-06T16:10:48Z

**Steps:**
  1. Gerar um vídeo acima de 16 MiB, criar o vídeo, assinar as partes e fazer PUT de cada uma, guardando o header `ETag`
    - expect: status 200 em cada `PUT`
  2. POST /videos/{publicId}/complete com o token do dono e `parts` com todos os `part_number` e `etag`
    - expect: status 200 e `status` igual a `processing` ou `ready`
  3. GET /videos/{publicId} em polling, até o `status` final
    - expect: `status` igual a `ready`, com `duration` e `thumbnail_url` preenchidas

#### 1.2. rejeita-lista-sem-parte

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-06T16:10:48Z

**Steps:**
  1. Enviar as duas partes e chamar POST /videos/{publicId}/complete com `parts` só com a parte 1
    - expect: status 409 e `error` igual a `UPLOAD_PARTS_MISMATCH`
  2. GET /videos/{publicId}/parts
    - expect: status 200, porque o upload continua aberto

#### 1.3. rejeita-etag-divergente

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-06T16:10:48Z

**Steps:**
  1. Enviar as duas partes e chamar POST /videos/{publicId}/complete com um `etag` alterado
    - expect: status 409 e `error` igual a `UPLOAD_PARTS_MISMATCH`
  2. GET /videos/{publicId}/parts
    - expect: status 200, porque o upload continua aberto

#### 1.4. rejeita-soma-diferente-do-declarado

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-06T16:10:48Z

**Steps:**
  1. Criar o vídeo com `declared_size` 20971520 e enviar as duas partes com total menor que o declarado
    - expect: status 200 em cada `PUT`
  2. POST /videos/{publicId}/complete com `parts` e `etag` corretos
    - expect: status 409 e `error` igual a `UPLOAD_PARTS_MISMATCH`
  3. GET /videos/{publicId}/parts
    - expect: status 200, porque o upload continua aberto

#### 1.5. repetir-depois-de-fechado-responde-estado-atual

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-06T16:10:48Z

**Steps:**
  1. Fechar um vídeo válido e observar `StorageService` com `jest.spyOn`
    - expect: o vídeo chega a `ready`
  2. POST /videos/{publicId}/complete de novo, com o vídeo em `ready`
    - expect: status 200, `status` igual a `ready` e nenhuma chamada ao storage
  3. Gravar no banco `status` igual a `processing` e repetir a chamada
    - expect: status 200, `status` igual a `processing` e nenhuma chamada ao storage
  4. Gravar no banco `status` igual a `error` e repetir a chamada
    - expect: status 200, `status` igual a `error` e nenhuma chamada ao storage

#### 1.6. repetir-em-draft-com-multipart-fechado-segue

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-06T16:10:48Z

**Steps:**
  1. Enviar as partes de um vídeo válido e fechar o multipart pelo `StorageService`, mantendo a linha em `draft`
    - expect: o objeto final existe com o tamanho declarado
  2. POST /videos/{publicId}/complete com `parts` e `etag` corretos
    - expect: status 200 e `status` diferente de `draft`
  3. GET /videos/{publicId} em polling, até o `status` final
    - expect: `status` igual a `ready`

#### 1.7. repetir-em-draft-sem-objeto-responde-erro

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-11-06T16:10:48Z

**Steps:**
  1. Abortar o multipart pelo `StorageService`, mantendo a linha em `draft`
    - expect: o aborto termina sem erro
  2. POST /videos/{publicId}/complete com `parts` preenchido
    - expect: status 409 e `error` igual a `UPLOAD_NOT_FOUND`

#### 1.8. repetir-nao-cria-segundo-job

**Covers AC:** #7
**Source:** auto
**Last sync:** 2026-11-06T16:10:48Z

**Steps:**
  1. Fechar um vídeo válido e obter o job de `jobId` igual ao `id` do vídeo na fila `video-processing`
    - expect: o job existe
  2. POST /videos/{publicId}/complete de novo
    - expect: status 200
    - expect: o job de mesmo `jobId` mantém o mesmo `timestamp`

#### 1.9. outro-usuario-sem-token-e-parts-vazio

**Covers AC:** #9
**Source:** auto
**Last sync:** 2026-11-06T16:10:48Z

**Steps:**
  1. POST /videos/{publicId}/complete com o token do outro usuário
    - expect: status 404 e `error` igual a `VIDEO_NOT_FOUND`
  2. POST /videos/{publicId}/complete sem o header `Authorization`
    - expect: status 401
  3. POST /videos/{publicId}/complete com o token do dono e `parts` igual a `[]`
    - expect: status 400 e `error` igual a `VALIDATION_ERROR`
