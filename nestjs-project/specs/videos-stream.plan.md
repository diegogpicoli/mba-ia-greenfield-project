---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.14
target_file: test/videos-stream.e2e-spec.ts
---

# GET /videos/{publicId}/stream — Test Plan

## Application Overview

`GET /videos/{publicId}/stream` entrega ao dono uma URL pré-assinada de leitura, válida por 6h. O storage atende por HTTP Range, então a reprodução não exige download completo e os bytes não passam pela API. Só vídeos em `ready` recebem URL.

## Test Scenarios

### 1. GET /videos/{publicId}/stream

**Setup:** `beforeAll` sobe `Test.createTestingModule({ imports: [AppModule] }).compile()` e reproduz a config global de `main.ts`. `beforeEach` limpa `ThrottlerStorage`, espera o `status` final dos vídeos enfileirados no teste anterior, chama `cleanAllTables`, cria dois usuários autenticados pelos endpoints de `auth` e, com o primeiro, leva um vídeo gerado por `src/test/generate-test-video.ts`, com `content_type` igual a `video/mp4`, até `ready` pelo fluxo de upload. As URLs assinadas são chamadas por `src/test/presigned-request.ts`. Postgres, Redis e MinIO são os do Compose, sem mocks. O teste espera o `video-worker` do Compose, e nenhum consumidor da fila sobe no teste.

#### 1.1. entrega-url-de-leitura

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-06T12:45:06Z

**Steps:**
  1. GET /videos/{publicId}/stream com o token do dono
    - expect: status 200
    - expect: `url` preenchida e `expires_at` cerca de 6h à frente

#### 1.2. url-responde-a-range

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-06T12:45:06Z

**Steps:**
  1. GET /videos/{publicId}/stream com o token do dono
    - expect: status 200
  2. GET na `url` com o header `Range: bytes=0-1023`
    - expect: status 206 e header `Content-Range` presente
    - expect: header `Content-Type` igual a `video/mp4`
    - expect: corpo com 1024 bytes

#### 1.3. rejeita-video-fora-de-ready

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-06T12:45:06Z

**Steps:**
  1. Gravar no banco `status` igual a `draft` e chamar GET /videos/{publicId}/stream
    - expect: status 409 e `error` igual a `VIDEO_NOT_READY`
  2. Gravar no banco `status` igual a `processing` e repetir a chamada
    - expect: status 409 e `error` igual a `VIDEO_NOT_READY`
  3. Gravar no banco `status` igual a `error` e repetir a chamada
    - expect: status 409 e `error` igual a `VIDEO_NOT_READY`

#### 1.4. outro-usuario-e-sem-token

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-06T12:45:06Z

**Steps:**
  1. GET /videos/{publicId}/stream com o token do outro usuário
    - expect: status 404 e `error` igual a `VIDEO_NOT_FOUND`
  2. GET /videos/{publicId}/stream sem o header `Authorization`
    - expect: status 401
