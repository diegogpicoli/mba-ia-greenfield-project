# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 17/18 completed

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
  - **Para a documentação da SI-03.17:** mudança no código do worker exige `docker compose restart video-worker`. O bind mount é `9p`, e nele nem `fs.watch` nem `nest start --watch` perceberam edição, feita no host ou dentro do container, mesmo com o compilador já em "Watching for file changes".
  - `start:worker` não usa `--watch`. Além de não recarregar, o CLI do Nest continua vivo quando o processo do worker morre, e o container nunca sairia para o `restart: unless-stopped` agir. O script compila e faz `exec node dist-worker/worker`, e o `command` faz `exec npm run start:worker`, então a morte do worker encerra o container.
  - O `video-worker` recebe `env_file` com `.env.example` e `.env` opcional, que prevalece. O plano não previa isso: um clone novo não tem `.env`, e a validação Joi exige as chaves. O `nestjs-api` segue dependendo de um `.env` para subir a aplicação.
  - Tempos medidos: primeira subida com `npm install` em volume vazio, de 1 a 2 min; clone novo com imagens em cache, 85 s; volta após a morte do processo, 38 s. Compilar o worker leva cerca de 30 s com o `node_modules` em volume, contra mais de 6 min com o `node_modules` no bind mount. O tempo com imagens construídas do zero não foi medido.
  - `docker compose stop video-worker` termina em 2 s, com `npm error signal SIGTERM` no log e código de saída 1. Isso é o `npm` relatando o sinal, e não uma falha do worker.
  - `dist-worker` saiu de `tsconfig.json` e `tsconfig.build.json`, para os `.d.ts` do worker não entrarem nas compilações da API. `tsconfig.worker.json` inclui só `src/worker.ts` e o que ele importa.
  - `src/worker.module.spec.ts` abre conexão real com `db` e `redis` ao compilar, como `channels.module.spec.ts`, porque o `TypeOrmModule.forRootAsync` conecta na compilação do módulo. O `close()` do Nest não dispara `onModuleInit`, então o teste não sobe consumidor.
  - Não provados: o consumo de jobs e a recuperação de job travado após a queda, porque o processor só chega na SI-03.7. O serviço ainda só registra a fila.

### SI-03.6 — Extração de metadados e thumbnail com FFmpeg
- **Status:** completed
- **Tests:** 36 passing (18 de integração com `ffprobe`, `ffmpeg` e MinIO reais + 18 unitários)
- **Observations:**
  - Saída do `ffprobe` 5.1.9 conferida no binário, fechando a lacuna de `library-refs.md`: `format.duration`, `format.bit_rate` e `format.format_name` são strings, e `streams[]` traz `codec_type`, `codec_name`, `width`, `height`, `duration` e `disposition.attached_pic`. O `container` é a lista do demuxer, como `mov,mp4,m4a,3gp,3g2,mj2`.
  - **Para a SI-03.7:** `VideoFileRejectedError` é falha permanente, e `MediaCommandError` é falha que pode ser repetida. O `ffprobe` sai com código 1 em todos os casos, então a distinção vem do texto do `stderr`, com as marcas em `REJECTED_FILE_STDERR_MARKERS`. `403`, `404`, `5xx`, conexão recusada, host desconhecido e tempo esgotado não são rejeição do arquivo.
  - Um objeto de 0 byte responde `4XX` ao `Range` e cai como falha repetível, não como rejeição. O `complete` exige soma igual a `declared_size`, que é no mínimo 1, então esse caso não chega ao worker pelo fluxo normal.
  - `-ss` depois do último frame termina com código 0 e sem arquivo, inclusive em vídeo de um frame com `-ss 0.004`. Por isso o recuo para o primeiro frame confere se o arquivo foi gravado, em vez de usar um limite de duração.
  - Os dois comandos usam `-rw_timeout` de 60 s. Sem ele, uma conexão parada mantém o processo vivo indefinidamente: o event loop segue renovando o lock do BullMQ, e o job nunca termina. Medido com 3 s: o `ffprobe` sai em 3,2 s com `Connection timed out`.
  - Mensagens de erro nunca carregam URLs, para a assinatura não ir parar nos logs nem no `failedReason`.
  - Um arquivo de áudio com capa tem stream `video` com `attached_pic`; isso conta como ausência de stream de vídeo.
  - Na 5.1.9, uma playlist servida por HTTP não lê arquivo local mesmo sem `-protocol_whitelist`, por causa de `allowed_segment_extensions` no HLS e do whitelist padrão de protocolos aninhados. O teste de `file://` direto é o que detecta a remoção da opção: sem ela, o `ffprobe` lê o arquivo.
  - Playlist com segmento `http://`: o whitelist de protocolos libera `http`, então, sem outra barreira, o processo requisita o endereço antes de falhar. Medido com um servidor local, que recebeu a requisição; dentro do Compose, o worker alcança `db`, `redis`, `minio` e `nestjs-api`. `-format_whitelist` com `MEDIA_ALLOWED_FORMATS` barra a playlist antes de qualquer requisição, nos dois comandos: os testes com servidor local falham sem a opção e passam com ela.
  - `MEDIA_ALLOWED_FORMATS` traz `mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,avi,mpegts,flv,asf,mpeg,ogg`, com os nomes conferidos em `ffmpeg -demuxers` na 5.1.9. Um arquivo real de `mp4`, `mov`, `3gp`, `matroska`, `webm`, `avi`, `mpegts`, `flv`, `asf`, `mpeg` e `ogg` passou no `ffprobe` com a lista ativa. Contêineres fora dela, como `mxf`, `rm`, `nut`, `wtv` e `dv`, e fluxos crus, como `h264` e `hevc`, passam a ser rejeitados. No `mov`, `enable_drefs` vem desligado, então faixas externas não são abertas.
  - No `mpegts`, `-ss 0.2` em um vídeo de 2 s termina com código 0 e sem arquivo, e o recuo para o primeiro frame cobre esse caso.
  - Para a SI-03.16: um `testsrc` de 5 s ocupa cerca de 80 KB, então um vídeo acima de 16 MiB precisa de outra fonte ou de bitrate alto em `generateTestVideo`.
  - Não provados: a leitura parcial por `Range` em arquivo grande, porque os vídeos de teste são pequenos; o valor de 60 s do `-rw_timeout`, medido só com 3 s; e, pelo serviço, formatos além de `mp4`, `matroska` e `mpegts`, porque os demais foram medidos uma vez, direto nos comandos.

### SI-03.7 — Processamento do vídeo no worker
- **Status:** completed
- **Tests:** 13 passing (8 de integração com Postgres, MinIO e FFmpeg reais + 4 unitários + 1 de compilação do `WorkerModule`)
- **Observations:**
  - Jobs reais no `video-worker` em execução, com `attempts: 3` e backoff exponencial de 30 s: vídeo válido termina em `completed` com `attemptsMade=1`, `ready` e thumbnail legível; arquivo de texto e `videoId` inexistente terminam em `failed` com `attemptsMade=1`, sem repetir; objeto ausente no storage (`404`) termina em `failed` com `attemptsMade=3`, passando duas vezes por `delayed`, e o evento `retries-exhausted`.
  - Recuperação de job travado provada: com o MinIO pausado para prender o `ffprobe`, `pkill -9` no worker com o job `active`. O container voltou, e o job seguiu `active > waiting > stalled > active > completed`, com `stalledCounter=1`, `attemptsStarted=2`, `attemptsMade=1` e `status` igual a `ready`. O travamento não consome tentativa.
  - Até a SI-03.8, um job em `failed` deixa o vídeo em `processing`; isso foi observado nos jobs de arquivo inválido e de objeto ausente.
  - Um `videoId` que não é UUID não vira `UnrecoverableError`: o Postgres responde `invalid input syntax for type uuid`, e o job termina em `failed` depois de 3 tentativas. A API só enfileira o `id` do vídeo, que é UUID.
  - Job com falha não aparece em `docker compose logs video-worker`: o motivo só fica em `failedReason`, no Redis.
  - Não provado: o diretório temporário numa queda durante `extractThumbnail`, que pode ficar no `/tmp` do container, porque o `finally` não roda e o reinício preserva o sistema de arquivos. Os dois travamentos seguidos foram provados na SI-03.8.

### SI-03.8 — Registro da falha no `status`
- **Status:** completed
- **Tests:** 20 passing (7 novos do listener, com Postgres e MinIO reais, + 13 da SI-03.7, que usam o mesmo serviço e o `WorkerModule`)
- **Observations:**
  - Conferido nos tipos instalados, fechando a divergência de `library-refs.md`: `lastEventId` existe em `QueueEventsOptions`, o `@QueueEventsListener` o repassa ao `QueueEvents`, e o handler de `failed` recebe objeto, `{ jobId, failedReason, prev? }`.
  - Jobs reais no `video-worker`: arquivo inválido chega a `error` em milissegundos depois do `failed`, com o objeto mantido no storage.
  - `failed` retido: com o serviço parado, um consumidor temporário fez um job real falhar, e o vídeo ficou em `processing`. Ao subir o serviço, a releitura do stream gravou `error`.
  - Dois travamentos seguidos: `pkill -9` com o job `active`, duas vezes. Os eventos foram `active > waiting > stalled > active > waiting > stalled > active > failed`, com `stalledCounter=2`, `failedReason` igual a `job stalled more than allowable limit` e `status` igual a `error`, com o objeto mantido. O `failed` só sai quando o job é pego pela terceira vez, em 12 ms e sem rodar o processamento, cerca de 1 min depois de o worker voltar.
  - Reler o stream não altera vídeo em `ready`: um `failed` injetado com `XADD` para um vídeo `ready` deixou `status`, metadados e thumbnail iguais depois do restart.
  - Falha ao gravar `error`: um `failed` injetado com `jobId` malformado gerou o log `Could not mark video not-a-uuid as error`, sem reinício do processo, e o job seguinte foi processado normalmente. Esse evento é registrado de novo a cada subida, enquanto ficar no stream; a API só enfileira UUID.
  - Cada subida relê todos os `failed` retidos, até cerca de 10.000 eventos, e a gravação condicional torna isso seguro.
  - Não provados com job real, só no teste de integração: `failed` de vídeo em `draft` e de `jobId` sem vídeo. Também não foi provada a perda de um `failed` aparado do stream, que exigiria mais de 10.000 eventos com o serviço parado.

### SI-03.9 — Endpoint POST /videos
- **Status:** completed
- **Tests:** 37 passing (6 do e2e da spec; 14 de `VideosService` e `VideosModule`, sendo 10 unitários, 3 de integração e 1 de compilação; 10 de `ChannelsService`, com os 2 novos de `findByUserId`; e 7 dos e2e de `AppModule` e Swagger)
- **Observations:**
  - `isPgUniqueViolationOnColumn` saiu de `channels.service.ts` para `src/common/database/pg-errors.ts`, porque `VideosService` é o segundo consumidor. O comportamento não mudou.
  - `test/support/videos-e2e.ts` concentra a montagem da aplicação e o cadastro com login, para os próximos e2e de vídeos. Ele pega `MailService` pelo contêiner, sem acessar campo privado de `AuthService`.
  - O canal é buscado antes de abrir o multipart, então não sobra upload para usuário sem canal. `findByUserId` usa `findOneByOrFail`, porque o cadastro sempre cria o canal.
  - Se a gravação falhar depois de abrir o multipart, o upload fica órfão até expirar por `MINIO_API_STALE_UPLOADS_EXPIRY`, em 7 dias. O contrato não prevê abortar nesse caso.
  - `content_type` com quebra de linha ou caractere não ASCII passa pelo DTO, que só limita o tamanho a 255, e falha no SDK (`ERR_INVALID_CHAR` e `SignatureDoesNotMatch`), sem tradução para erro de domínio. Medido só no SDK, sem chamar a rota. O cabeçalho não chega a ser injetado.
  - Com o `StorageModule` no `VideosModule`, a API também provisiona os buckets ao subir, e todo e2e sobre `AppModule` passa a depender do MinIO.
  - `openapi.json` e `src/metadata.ts` não foram regenerados, porque isso é da SI-03.17.

### SI-03.10 — Endpoint GET /videos/{publicId}
- **Status:** completed
- **Tests:** 30 passing (5 do e2e da spec, 6 do e2e de `videos-create` e 19 de `VideosService`, sendo 13 unitários e 6 de integração)
- **Observations:**
  - `@SkipThrottle()` provado: sem ele, o cenário `nao-limita-polling-de-status` falha, com `429` na 11ª e na 12ª requisição.
  - `findOwned` usa uma única consulta, filtrando por `channel.user_id`, então vídeo de outro canal e `public_id` inexistente dão o mesmo corpo de `404`. As próximas rotas de dono usam esse método.
  - A montagem de `thumbnail_url` ficou em `StorageService.getThumbnailUrl`, porque o endpoint público e o bucket são do storage.
  - Não provado aqui: `thumbnail_url` apontando para um objeto real, porque o e2e grava `ready` direto na linha. A prova fica para a SI-03.16.

### SI-03.11 — Endpoint POST /videos/{publicId}/parts/sign
- **Status:** completed
- **Tests:** 44 passing (6 do e2e da spec, 11 dos e2e de `videos-get` e `videos-create` e 27 de `VideosService`, sendo 19 unitários e 8 de integração)
- **Observations:**
  - `expires_at` é a menor validade entre as URLs assinadas no lote, porque cada assinatura calcula a sua.
  - O limite de 640 itens vem de `VIDEO_MAX_PART_COUNT`, derivado de `VIDEO_MAX_SIZE_BYTES` e `VIDEO_PART_SIZE_BYTES`. Assinar as 640 partes de um vídeo de 10 GiB levou 336 ms no teste de integração.
  - A verificação de faixa roda antes de assinar, então uma lista com um número fora de `part_count` não assina nenhuma parte.
  - Não provado: a expiração real da URL, porque os testes conferem `expires_at` sem esperar 1h.

### SI-03.12 — Endpoint GET /videos/{publicId}/parts
- **Status:** completed
- **Tests:** 46 passing (5 do e2e da spec, 6 do e2e de `videos-parts-sign` e 35 de `VideosService`, sendo 25 unitários e 10 de integração)
- **Observations:**
  - O `etag` de `uploaded_parts` é igual ao header `ETag` que o cliente recebe no `PUT`, com as aspas, conforme o teste de integração no MinIO. Um cliente que perdeu a própria lista pode usá-lo sem converter o formato.
  - `missing_part_numbers` é calculado de 1 até `part_count`, sem depender da ordem do `ListParts`.
  - A exigência de `draft` foi para `findOwnedDraft`, usado por `signParts` e `getUploadProgress`, sem mudar o comportamento de `signParts`.
  - Não provado: a resposta com mais de uma página de `ListParts` por este endpoint. Um vídeo tem no máximo 640 partes, e a página é de 1.000. A paginação foi provada na SI-03.4, no `StorageService`.

### SI-03.13 — Endpoint POST /videos/{publicId}/complete
- **Status:** completed
- **Tests:** 155 passing (9 do e2e da spec, 22 dos demais e2e de vídeos, 52 de `app`, `swagger` e `auth`, 13 de `part-verification.util`, 40 unitários de `VideosService`, 18 de integração e 1 de `VideosModule`)
- **Observations:**
  - Com o `video-worker` do Compose e um vídeo de 25 MiB em duas partes, a sequência observada foi `processing` na resposta do `complete` e `ready` no `GET` seguinte. Em vídeos menores, o `complete` pode já responder `ready`, porque o `status` é relido depois da gravação.
  - Soma acima de 10 GiB é provada com a listagem simulada, porque um envio real desse tamanho não cabe no ambiente. O aborto é real, e o `ListParts` seguinte responde `NoSuchUpload`.
  - O `ready` ou `error` gravado antes de `processing` é provado com `queue.add` simulado gravando o `status` no Postgres real, para fixar a ordem. A gravação condicional é a real.
  - A AWS documenta `InvalidPartOrder` para lista fora de ordem no `CompleteMultipartUpload`, então a lista é ordenada antes de fechar. A lista invertida e os ETags sem aspas são aceitos pelo MinIO no teste de integração.
  - `generateTestVideo` ganhou a opção `noise`, com cerca de 8 MiB por segundo de vídeo, para arquivos com mais de uma parte. `discardTestVideos`, em `src/test/`, espera a fila esvaziar e remove o que as linhas apontam no storage e na fila.
  - `AppModule` agora abre conexão com o Redis, então os e2e que sobem o módulo dependem do serviço `redis`.
  - Limite conhecido: soma correta com parte intermediária abaixo de 5 MiB passa na verificação, e o `CompleteMultipartUpload` responde `EntityTooSmall`. A API devolve `500`, e o upload continua aberto. O contrato não prevê esse caso, e um cliente que segue o `part_size` devolvido por `POST /videos` não chega a ele.
  - Não provado: o `complete` com o Redis fora do ar, e um `PUT` repetido entre a verificação e o fechamento, que levaria a `InvalidPart`.

### SI-03.14 — Endpoint GET /videos/{publicId}/stream
- **Status:** completed
- **Tests:** 76 passing (4 do e2e da spec, 9 do e2e de `videos-complete` e 63 de `VideosService`, sendo 44 unitários e 19 de integração)
- **Observations:**
  - A URL assinada pelo endpoint público responde a um `Range` no meio do arquivo com `206`, o `Content-Range` e exatamente aqueles bytes, conforme o teste de integração no MinIO.
  - O `Content-Type` do `GetObject` é o informado em `POST /videos`, gravado no `CreateMultipartUpload`.
  - O fluxo de upload até o `status` final foi para `test/support/videos-e2e.ts`, para servir aos e2e que precisam de um vídeo em `ready`.
  - Não provado: a expiração real da URL, porque os testes conferem `expires_at` e `X-Amz-Expires` sem esperar 6h, e o `403` do storage depois de expirar.

### SI-03.15 — Endpoint GET /videos/{publicId}/download
- **Status:** completed
- **Tests:** 94 passing (5 do e2e da spec, 4 do e2e de `videos-stream`, 15 de `content-disposition.util` e 70 de `VideosService`, sendo 48 unitários e 22 de integração)
- **Observations:**
  - O header tem sempre os dois parâmetros, por exemplo `attachment; filename="a__o.mp4"; filename*=UTF-8''a%C3%A7%C3%A3o.mp4`. Em `filename`, tudo fora de ASCII imprimível, aspas, barra invertida, ponto e vírgula e `%` vira `_`. O `%` sai porque há clientes que decodificam `%XX` nesse parâmetro.
  - O `filename*` preserva o nome inteiro, inclusive uma quebra de linha, que vai como `%0A` e não chega ao header. Tratar esse caractere ao gravar o arquivo fica a cargo do cliente.
  - Um nome com o tamanho máximo de `POST /videos`, 251 caracteres de 3 bytes em UTF-8 mais a extensão, atravessa a URL assinada e volta intacto no header do MinIO.
  - Um surrogate solto em `original_filename` é aceito pela validação e vira `U+FFFD` ao gravar no Postgres, então `encodeURIComponent` não lança erro no download.
  - A exigência de `ready` foi para `findOwnedReady`, usado por `getStreamUrl` e `getDownloadUrl`, sem mudar o comportamento de `getStreamUrl`.
  - Não provado: o nome com que um navegador salva o arquivo, porque a tela está fora desta fase, e a expiração real da URL, porque os testes não esperam 6h.

### SI-03.16 — Prova do fluxo completo com infra real
- **Status:** completed
- **Tests:** 13 passing, em `test/videos-flow.e2e-spec.ts`, com Postgres, Redis, MinIO e o `video-worker` do Compose
- **Observations:**
  - `draft` é lido na resposta de `POST /videos`, em um `GET` logo depois dele e em outro depois dos `PUT`.
  - `processing` é lido na resposta do `complete` e em um `GET` feito com a fila pausada. Com a pausa, feita antes do `complete`, o job espera e o worker não leva o vídeo a `ready` entre duas leituras. A pausa não grava `status`: o `processing` é o que a API grava.
  - `ready` é lido no polling depois de despausar a fila, gravado pelo `video-worker`.
  - O vídeo tem cerca de 24 MiB, em duas partes. A leitura integral e um `Range` que atravessa o limite entre as duas partes devolvem exatamente os bytes enviados.
  - `queue.getWorkers()` conta a conexão bloqueante de cada worker e não inclui a do `QueueEvents`, então um `video-worker` conta como 1.
  - Pelo host, nas URLs de `localhost:9000`: thumbnail `200` com `image/jpeg`, listagem do bucket `403`, stream com `Range` `206`, stream sem assinatura `403`, e download com `Content-Disposition: attachment` e o mesmo SHA-256 do arquivo.
  - Um arquivo de texto termina em `error` com uma tentativa só, conforme a SI-03.8, e o original continua legível no storage.
  - Não provado: reprodução em um navegador real, e o fluxo com mais de um `video-worker`. No arquivo inválido, a passagem por `processing` não é verificada, porque a fila não é pausada nesse caso.

### SI-03.17 — Documentação e contrato OpenAPI
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.18 (amendment of SI-03.5) — `env_file` no `video-worker` e `start:worker` sem `--watch`
- **Status:** completed
- **Tests:** no tests
- **Observations:**
  - Registra no plano a revisão de 2026-11-06 do `phase-03-videos/TD-05`, sem mudança de código.
  - Clone novo em `86a3beb`, sem `.env`, `node_modules` nem `dist`: `docker compose up -d` deixou o `video-worker` com o contexto iniciado em 3 min 48 s, dos quais 3 min de `npm install`, com `RestartCount` 0 e sem nenhum `docker compose exec`. `S3_BUCKET_VIDEOS` veio do `env_file`, e o `.env` continuou ausente. As imagens estavam em cache, então o tempo com imagens construídas do zero segue sem medição.
  - `pkill -9` em `node dist-worker/worker`, no stack principal: `RestartCount` foi de 0 para 1, e o contexto voltou em 25 s.
