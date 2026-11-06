---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.10
target_file: test/videos-get.e2e-spec.ts
---

# GET /videos/{publicId} — Test Plan

## Application Overview

`GET /videos/{publicId}` expõe ao dono o recurso do vídeo, usado para consultar o `status` por polling. Quem não é dono recebe a mesma resposta de um vídeo inexistente, sem revelar que o vídeo existe.

## Test Scenarios

### 1. GET /videos/{publicId}

**Setup:** `beforeAll` sobe `Test.createTestingModule({ imports: [AppModule] }).compile()` e reproduz a config global de `main.ts`. `beforeEach` limpa `ThrottlerStorage`, chama `cleanAllTables` e cria dois usuários autenticados pelos endpoints de `auth`. O primeiro cria o vídeo com `POST /videos`. Postgres, Redis e MinIO são os do Compose, sem mocks, e nenhum consumidor da fila sobe no teste.

#### 1.1. dono-le-rascunho

**Covers AC:** #1, #5
**Source:** auto
**Last sync:** 2026-11-06T12:45:06Z

**Steps:**
  1. GET /videos/{publicId} com o token do dono, com o vídeo em `draft`
    - expect: status 200 e `status` igual a `draft`
    - expect: `duration`, `width`, `height`, `video_codec`, `audio_codec`, `bitrate`, `container` e `thumbnail_url` nulos
    - expect: o corpo não traz `id`, `channel_id`, `upload_id` nem `source_key`

#### 1.2. dono-le-video-pronto

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-06T12:45:06Z

**Steps:**
  1. Gravar no banco `status` igual a `ready`, com metadados e `thumbnail_key`
    - expect: a linha fica atualizada
  2. GET /videos/{publicId} com o token do dono
    - expect: status 200 e metadados preenchidos
    - expect: `thumbnail_url` igual a `{S3_PUBLIC_ENDPOINT}/{S3_BUCKET_THUMBNAILS}/{thumbnail_key}`

#### 1.3. outro-usuario-recebe-404-igual-a-inexistente

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-06T12:45:06Z

**Steps:**
  1. GET /videos/{publicId} com o token do outro usuário
    - expect: status 404 e `error` igual a `VIDEO_NOT_FOUND`
  2. GET /videos/{publicId} com um `public_id` inexistente e o token do dono
    - expect: status 404 e o mesmo corpo do passo anterior

#### 1.4. rejeita-sem-token

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-06T12:45:06Z

**Steps:**
  1. GET /videos/{publicId} sem o header `Authorization`
    - expect: status 401

#### 1.5. nao-limita-polling-de-status

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-11-06T14:12:23Z

**Steps:**
  1. GET /videos/{publicId} com o token do dono, mais de 10 vezes dentro de um minuto
    - expect: nenhuma resposta 429
