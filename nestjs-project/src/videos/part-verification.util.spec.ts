import type { UploadedPart } from '../storage/storage.service';
import { partsMatchDeclaredFile, sumPartSizes } from './part-verification.util';

const PART_SIZE = 16777216;
const DECLARED_SIZE = PART_SIZE + 1024;

function storedPart(partNumber: number, size: number): UploadedPart {
  return { partNumber, etag: `"etag-${partNumber}"`, size };
}

function clientPart(partNumber: number) {
  return { part_number: partNumber, etag: `"etag-${partNumber}"` };
}

const STORED_PARTS = [storedPart(1, PART_SIZE), storedPart(2, 1024)];
const CLIENT_PARTS = [clientPart(1), clientPart(2)];

function matches(
  overrides: Partial<Parameters<typeof partsMatchDeclaredFile>[0]> = {},
): boolean {
  return partsMatchDeclaredFile({
    clientParts: CLIENT_PARTS,
    storedParts: STORED_PARTS,
    partCount: 2,
    declaredSize: DECLARED_SIZE,
    ...overrides,
  });
}

describe('part-verification.util', () => {
  describe('sumPartSizes', () => {
    it('should add the size of every part', () => {
      expect(sumPartSizes(STORED_PARTS)).toBe(DECLARED_SIZE);
    });

    it('should be zero without parts', () => {
      expect(sumPartSizes([])).toBe(0);
    });
  });

  describe('partsMatchDeclaredFile', () => {
    it('should accept the parts 1..N with the same ETags and the declared size', () => {
      expect(matches()).toBe(true);
    });

    it('should accept the client list in any order', () => {
      expect(matches({ clientParts: [clientPart(2), clientPart(1)] })).toBe(
        true,
      );
    });

    it('should ignore the quotes when comparing the ETags', () => {
      expect(
        matches({
          clientParts: [
            { part_number: 1, etag: 'etag-1' },
            { part_number: 2, etag: '"etag-2"' },
          ],
        }),
      ).toBe(true);
    });

    it('should refuse a client list without a part', () => {
      expect(matches({ clientParts: [clientPart(1)] })).toBe(false);
    });

    it('should refuse a client list with more parts than planned', () => {
      expect(matches({ clientParts: [...CLIENT_PARTS, clientPart(3)] })).toBe(
        false,
      );
    });

    it('should refuse a client list with a repeated part', () => {
      expect(matches({ clientParts: [clientPart(1), clientPart(1)] })).toBe(
        false,
      );
    });

    it('should refuse a part that did not reach the storage', () => {
      expect(
        matches({
          storedParts: [storedPart(1, DECLARED_SIZE)],
        }),
      ).toBe(false);
    });

    it('should refuse a stored part outside 1..N, even with the right sum', () => {
      expect(
        matches({
          clientParts: [clientPart(1), clientPart(3)],
          storedParts: [storedPart(1, PART_SIZE), storedPart(3, 1024)],
        }),
      ).toBe(false);
    });

    it('should refuse a different ETag', () => {
      expect(
        matches({
          clientParts: [clientPart(1), { part_number: 2, etag: '"other"' }],
        }),
      ).toBe(false);
    });

    it('should refuse a sum below the declared size', () => {
      expect(
        matches({
          storedParts: [storedPart(1, PART_SIZE), storedPart(2, 1023)],
        }),
      ).toBe(false);
    });

    it('should refuse a sum above the declared size', () => {
      expect(
        matches({
          storedParts: [storedPart(1, PART_SIZE), storedPart(2, 1025)],
        }),
      ).toBe(false);
    });
  });
});
