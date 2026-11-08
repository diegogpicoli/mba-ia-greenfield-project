import type { UploadedPart } from '../storage/storage.service';
import type { CompletedPartDto } from './dto/complete-video.dto';

interface PartVerification {
  clientParts: CompletedPartDto[];
  storedParts: UploadedPart[];
  partCount: number;
  declaredSize: number;
}

function withoutQuotes(etag: string): string {
  return etag.replaceAll('"', '');
}

export function sumPartSizes(parts: UploadedPart[]): number {
  return parts.reduce((total, { size }) => total + size, 0);
}

/**
 * Both lists must hold exactly the parts 1..partCount, with the same ETags, and
 * the stored parts must add up to the declared size. A list with a repeated
 * number has the right length but misses another number, so it does not match.
 */
export function partsMatchDeclaredFile({
  clientParts,
  storedParts,
  partCount,
  declaredSize,
}: PartVerification): boolean {
  if (
    clientParts.length !== partCount ||
    storedParts.length !== partCount ||
    sumPartSizes(storedParts) !== declaredSize
  ) {
    return false;
  }
  const clientEtags = new Map(
    clientParts.map(({ part_number, etag }) => [
      part_number,
      withoutQuotes(etag),
    ]),
  );
  const storedEtags = new Map(
    storedParts.map(({ partNumber, etag }) => [
      partNumber,
      withoutQuotes(etag),
    ]),
  );
  for (let partNumber = 1; partNumber <= partCount; partNumber++) {
    const storedEtag = storedEtags.get(partNumber);
    if (
      storedEtag === undefined ||
      storedEtag !== clientEtags.get(partNumber)
    ) {
      return false;
    }
  }
  return true;
}
