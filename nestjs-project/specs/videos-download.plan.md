---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.15
target_file: test/videos-download.e2e-spec.ts
---

# GET /videos/{publicId}/download — Test Plan

## Application Overview

`GET /videos/{publicId}/download` entrega ao dono uma URL pré-assinada de download, com `ResponseContentDisposition: attachment` e o nome original codificado, para aspas, quebras de linha e acentos não quebrarem o header. Só vídeos em `ready` recebem URL.

## Test Scenarios

### 1. GET /videos/{publicId}/download

**Setup:** `beforeAll` sobe `Test.createTestingModule({ imports: [AppModule] }).compile()` e reproduz a config global de `main.ts`. `beforeEach` limpa `ThrottlerStorage`, espera o `status` final dos vídeos enfileirados no teste anterior, chama `cleanAllTables`, cria dois usuários autenticados pelos endpoints de `auth` e, com o primeiro, leva um vídeo gerado por `src/test/generate-test-video.ts` até `ready` pelo fluxo de upload. As URLs assinadas são chamadas por `src/test/presigned-request.ts`. Postgres, Redis e MinIO são os do Compose, sem mocks. O teste espera o `video-worker` do Compose, e nenhum consumidor da fila sobe no teste.

#### 1.1. entrega-url-de-download

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-06T16:10:48Z

**Steps:**
  1. GET /videos/{publicId}/download com o token do dono
    - expect: status 200
    - expect: `url` preenchida e `expires_at` preenchido

#### 1.2. url-responde-attachment

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-06T16:10:48Z

**Steps:**
  1. Levar até `ready` um vídeo com `original_filename` igual a `aula.mp4` e chamar GET /videos/{publicId}/download
    - expect: status 200
  2. GET na `url`
    - expect: status 200
    - expect: header `Content-Disposition` começando por `attachment` e trazendo `aula.mp4`

#### 1.3. nome-com-aspas-quebra-de-linha-e-acentos

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-06T16:10:48Z

**Steps:**
  1. Levar até `ready` um vídeo com `original_filename` contendo aspas, quebra de linha e acentos, e chamar GET /videos/{publicId}/download
    - expect: status 200
  2. GET na `url`
    - expect: status 200
    - expect: header `Content-Disposition` sem quebra de linha e sem aspas soltas no `filename`
    - expect: o `filename*` decodificado preserva os acentos

#### 1.4. rejeita-video-fora-de-ready

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-06T16:10:48Z

**Steps:**
  1. Gravar no banco `status` igual a `processing` e chamar GET /videos/{publicId}/download
    - expect: status 409 e `error` igual a `VIDEO_NOT_READY`

#### 1.5. outro-usuario-e-sem-token

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-06T16:10:48Z

**Steps:**
  1. GET /videos/{publicId}/download com o token do outro usuário
    - expect: status 404 e `error` igual a `VIDEO_NOT_FOUND`
  2. GET /videos/{publicId}/download sem o header `Authorization`
    - expect: status 401
