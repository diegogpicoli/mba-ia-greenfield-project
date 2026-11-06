---
libs:
  bullmq:
    version: "^6"
    context7_id: "/taskforcesh/bullmq/v6.5.3"
    fetched_at: "2026-11-05T20:34:02-03:00"
  ioredis:
    version: ">=5.0.0"
    context7_id: "/redis/ioredis"
    fetched_at: "2026-11-05T20:34:02-03:00"
  "@nestjs/bullmq":
    version: "11.0.5"
    context7_id: "/nestjs/bull"
    fetched_at: "2026-11-05T20:34:02-03:00"
  "@aws-sdk/client-s3":
    version: "^3"
    context7_id: "/aws/aws-sdk-js-v3/v3.1153.0"
    fetched_at: "2026-11-05T20:34:02-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3"
    context7_id: "/aws/aws-sdk-js-v3/v3.1153.0"
    fetched_at: "2026-11-05T20:34:02-03:00"
  ffmpeg:
    version: "apt, sem versão fixa"
    context7_id: "/websites/ffmpeg_documentation"
    fetched_at: "2026-11-05T20:34:02-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-06T09:39:03.497955700-03:00"
---

# phase-03-videos — Library References

Resumo da documentação das libs decididas nesta fase, obtida pelo Context7. Cada seção traz só o que o Context7 devolveu para o uso previsto nos TDs. O que não veio está marcado como lacuna, para ser conferido no pacote instalado durante a implementação.

### bullmq

**Source:** `/taskforcesh/bullmq/v6.5.3` (Context7), reputação High, 4503 snippets, benchmark 72.54. Atende `phase-03-videos/TD-01` e `phase-03-videos/TD-10`.

**Versão:** `^6`, fixada pelo TD-01. A documentação consultada é a 6.5.3, dentro da faixa. O npm estava em 6.7.0 na consulta de 2026-11-05.

#### Retries e falha definitiva

Com backoff exponencial, a espera é `2^(attempts-1) * delay` em milissegundos. Lançar `UnrecoverableError` no processor leva o job direto para `failed`, ignorando `attempts`.

```typescript
import { Worker, UnrecoverableError } from 'bullmq';

await queue.add(name, data, {
  jobId: videoId,
  attempts: 3,
  backoff: { type: 'exponential', delay: 30000 },
});

throw new UnrecoverableError('arquivo inválido');
```

Os valores 3 tentativas e 30 s vêm do TD-10.

#### Evento de falha

`QueueEvents` recebe eventos de todos os workers. O `failed` entrega um objeto com `jobId` e `failedReason`:

```typescript
queueEvents.on('failed', ({ jobId, failedReason }) => {});
```

#### Job travado e lock

A entrega é "ao menos uma vez". O lock do job dura `lockDuration` e é renovado em `lockRenewTime`, normalmente metade desse valor. Sem renovação, o job é tratado como travado e reprocessado. Um processor que bloqueia o event loop causa isso. A recuperação tem limite de `maxStalledCount`, padrão `1`.

Esse trecho vem da seção de notas sobre o Bull dentro da documentação do repositório. O valor padrão de `lockDuration` citado no TD-05 não apareceu no que o Context7 devolveu.

#### Conexão

Workers com ioredis precisam de `maxRetriesPerRequest: null`. O `Worker` define isso por padrão e avisa se o valor for sobrescrito. Um cliente ioredis criado à mão com outro valor gera exceção ao ser passado ao worker.

#### Deduplicação por `jobId`

O id customizado precisa ser único na fila, e um `add` com id existente é ignorado. Evite `:` e ids só com dígitos. Um job removido por `removeOnComplete` ou `removeOnFailed` deixa de contar como existente, então o mesmo id pode entrar de novo. Isso afeta a repetição segura do `complete` no `phase-03-videos/TD-09`.

### ioredis

**Source:** `/redis/ioredis` (Context7), reputação High, 9522 snippets, benchmark 69.36. Atende `phase-03-videos/TD-01`.

**Versão:** o TD-01 pede `ioredis` explícito e não fixa versão. `>=5.0.0` é o peer declarado por `bullmq` na consulta ao npm de 2026-11-05. O npm estava em 6.0.0. A documentação consultada é a da branch principal, sem versão fixa. A versão exata fica para a implementação escolher.

Aceita um objeto de opções com `host`, `port`, `username`, `password` e `db`:

```typescript
new Redis({ host: 'redis', port: 6379, maxRetriesPerRequest: null });
```

O host segue a regra de rede do repositório: nome do serviço no Compose. O padrão de `maxRetriesPerRequest` é `20`, e `null` remove o limite, fazendo os comandos esperarem indefinidamente.

### @nestjs/bullmq

**Source:** `/nestjs/bull` (Context7), reputação High, 316 snippets, benchmark 83.3, para a API. `/nestjs/docs.nestjs.com/__branch__11.0.0` (Context7) para os padrões de uso. Atende `phase-03-videos/TD-01` e `phase-03-videos/TD-10`.

**Versão:** `11.0.5`, fixada pelo TD-01. O npm confirma para essa versão os peers `bullmq ^3 || ^4 || ^5 || ^6` e `@nestjs/core` e `@nestjs/common` `^10 || ^11`.

**Divergência de versão:** `/nestjs/bull` responde pela branch `master` e não oferece versão fixa. Nada do que veio dele está garantido para a `11.0.5`, então a seção usa a documentação do NestJS 11 quando ela cobre o assunto.

#### Módulo

```typescript
BullModule.forRootAsync({
  imports: [ConfigModule],
  useFactory: (config: ConfigType<typeof queueConfig>) => ({ connection: config.connection }),
  inject: [queueConfig.KEY],
});

BullModule.registerQueue({ name: queueName });
```

`forRootAsync` aceita `useFactory`, `useClass`, `useExisting`, `inject` e `imports`. O nome `queueConfig` é só ilustrativo. `forRootAsync` e `registerQueue` vêm de `/nestjs/bull`.

#### Processor

A classe usa `@Processor(fila)`, estende `WorkerHost`, implementa `process` e precisa estar registrada como provider:

```typescript
@Processor(queueName)
export class VideoProcessor extends WorkerHost {
  async process(job: Job): Promise<void> {}
}
```

#### Eventos da fila

A classe usa `@QueueEventsListener(fila)`, estende `QueueEventsHost` e também é registrada como provider. Cada evento usa `@OnQueueEvent(evento)`.

**Divergência na assinatura:** a documentação do NestJS 11 mostra o handler recebendo um objeto (`job: { jobId: string; prev?: string }`), como o `failed` do BullMQ. A documentação de `/nestjs/bull` mostra argumentos posicionais (`jobId, failedReason`). Siga a forma com objeto e confirme nos tipos do pacote instalado, porque o `phase-03-videos/TD-10` depende desse `jobId`.

### @aws-sdk/client-s3

**Source:** `/aws/aws-sdk-js-v3/v3.1153.0` (Context7), reputação High, 11189 snippets, benchmark 64.28, para o cliente. `/websites/aws_amazon_s3` (Context7), reputação High, benchmark 77.74, para as operações. Atende `phase-03-videos/TD-02` e `phase-03-videos/TD-03`.

**Versão:** `^3`, porque o TD-02 fala em SDK v3 sem fixar versão. A documentação consultada é a 3.1153.0. O npm estava em 3.1163.0.

**Lacuna:** o Context7 não devolveu as páginas dos comandos de multipart do SDK, só o padrão de importação (`import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'`). Os nomes das classes e os campos de entrada precisam ser conferidos nos tipos do pacote. A documentação das operações é a do Amazon S3, não a do MinIO.

#### Cliente

```typescript
new S3Client({
  endpoint: 'http://minio:9000',
  forcePathStyle: true,
  requestChecksumCalculation: 'WHEN_REQUIRED',
});
```

`requestChecksumCalculation` aceita `WHEN_REQUIRED` ou `WHEN_SUPPORTED`. `forcePathStyle` é o nome na v3 do antigo `s3ForcePathStyle`. O endpoint segue o `phase-03-videos/TD-03`.

#### Multipart

| Item | Limite |
|------|--------|
| Partes por upload | até 10.000, numeradas de 1 a 10.000 |
| Tamanho da parte | 5 MiB a 5 GiB, sem mínimo para a última |
| Partes por resposta de `ListParts` | até 1.000 |

- Enviar de novo o mesmo número de parte sobrescreve a anterior.
- `ListParts` pagina com `IsTruncated` e `NextPartNumberMarker` acima de 1.000 partes, e não lista parte ainda em envio.
- `CompleteMultipartUpload` recebe `PartNumber` e `ETag` de cada parte, em ordem crescente, e junta só as partes da lista.
- Erros do `complete`: `EntityTooSmall`, `InvalidPart`, `InvalidPartOrder` e `NoSuchUpload`.

#### Ressalva sobre o TD-02 (resolvida)

A Recommendation do `phase-03-videos/TD-02` monta o `complete` com os ETags do `ListParts`, e a AWS orienta o contrário. O guia geral de multipart (`mpuoverview`, em "Multipart upload listings") e a página de multipart de S3 Express trazem o mesmo aviso: usar a listagem só como verificação e manter a própria lista de partes e ETags para o `complete`. O guia geral marca o aviso como "Important" e também manda registrar número e ETag de cada parte no envio.

Como a listagem omite partes em envio e o `complete` junta só o que recebe, um `complete` montado com ela poderia gerar um vídeo truncado sem erro.

A revisão de 2026-11-05 no TD-02 resolve o ponto: o `complete` recebe a lista do cliente, e o `ListParts` só verifica partes, ETags e soma. O cliente passa a ler o header `ETag`, o que em navegador depende de CORS, a conferir na fase que trouxer tela.

### @aws-sdk/s3-request-presigner

**Source:** `/aws/aws-sdk-js-v3/v3.1153.0` (Context7), reputação High, 11189 snippets, benchmark 64.28. Atende `phase-03-videos/TD-02` e `phase-03-videos/TD-08`.

**Versão:** `^3`, pela mesma razão de `@aws-sdk/client-s3`. O npm estava em 3.1163.0.

```typescript
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const url = await getSignedUrl(client, command, { expiresIn: 3600 });
```

`expiresIn` é opcional e o padrão é 900 segundos. O TD-02 usa 1h e o TD-08 usa 6h. Funciona para outras operações além de `GetObject`.

`signableHeaders` obriga headers comuns, como `content-type`, a entrar na assinatura. `unhoistableHeaders` faz o mesmo para headers `x-amz-*`.

**Lacuna:** não vieram exemplos específicos de `UploadPart` nem de `ResponseContentDisposition`, usados pelo TD-02 e pelo TD-08.

### ffmpeg

**Source:** `/websites/ffmpeg_documentation` (Context7), reputação High, 4613 snippets, benchmark 62.76, com conteúdo de `ffmpeg.org/ffmpeg-all.html`. Atende `phase-03-videos/TD-06`.

**Versão:** instalada por `apt` no worker, conforme o `phase-03-videos/TD-05`, sem versão fixa. A imagem base `node:25.6.0-slim` não estava em cache e não foi baixada, então a versão real não foi checada. A documentação é a do site, sem versão fixa, e pode divergir do pacote do apt.

#### Protocolos

`-protocol_whitelist` recebe uma lista separada por vírgulas e é opção de entrada. Por padrão todos os protocolos são permitidos, com subconjunto restrito só para protocolos aninhados. É o que justifica a restrição no TD-06.

#### Thumbnail

`-ss` antes de `-i` busca o ponto de seek mais próximo antes da posição. Ao transcodificar, com `-accurate_seek` ligado por padrão, o trecho até a posição é decodificado e descartado. `-frames:v 1` com `-f image2` e nome sem `%d` grava uma única imagem:

```shell
ffmpeg -protocol_whitelist http,https,tcp,tls -ss <posição> -i <url> -frames:v 1 -f image2 <saída>.jpg
```

O comando combina as opções acima com os protocolos do TD-06 e não foi executado.

#### ffprobe

**Lacuna:** o Context7 não devolveu a descrição de `-show_format` nem de `-show_streams`, e os exemplos que vieram usam `-show_entries` com `-of csv`. O formato de saída em JSON e os nomes de campo precisam ser conferidos com `ffprobe` na imagem do worker.
