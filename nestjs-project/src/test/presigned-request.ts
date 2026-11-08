import { request, type IncomingHttpHeaders } from 'node:http';

export interface PresignedResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

interface PresignedRequestOptions {
  method?: 'GET' | 'PUT';
  headers?: Record<string, string>;
  body?: Buffer;
}

/**
 * Sends a request to a presigned URL from inside the container.
 *
 * URLs meant for the client are signed for S3_PUBLIC_ENDPOINT (localhost:9000),
 * which is not MinIO inside a container, and the signature covers the host. So
 * this connects to S3_ENDPOINT while sending the Host of the signed URL. It uses
 * node:http because fetch does not allow setting the Host header.
 */
export function presignedRequest(
  signedUrl: string,
  options: PresignedRequestOptions = {},
): Promise<PresignedResponse> {
  const { method = 'GET', headers = {}, body } = options;
  const target = new URL(signedUrl);
  const endpoint = new URL(process.env.S3_ENDPOINT!);

  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        hostname: endpoint.hostname,
        port: endpoint.port,
        method,
        path: `${target.pathname}${target.search}`,
        headers: {
          ...headers,
          Host: target.host,
          ...(body !== undefined && { 'Content-Length': body.length }),
        },
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
        incoming.on('error', reject);
        incoming.on('end', () =>
          resolve({
            status: incoming.statusCode!,
            headers: incoming.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    outgoing.on('error', reject);
    outgoing.end(body);
  });
}
