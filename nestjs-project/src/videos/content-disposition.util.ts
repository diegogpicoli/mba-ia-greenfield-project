const UNSAFE_IN_ASCII_FILENAME = /[^\x20-\x7e]|["\\;%]/gu;

const NOT_ATTR_CHAR_AFTER_URI_ENCODING = /['()*]/g;

const ASCII_FILENAME_REPLACEMENT = '_';

function toAsciiFilename(filename: string): string {
  return filename.replace(UNSAFE_IN_ASCII_FILENAME, ASCII_FILENAME_REPLACEMENT);
}

function toExtendedValue(filename: string): string {
  return encodeURIComponent(filename).replace(
    NOT_ATTR_CHAR_AFTER_URI_ENCODING,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * Builds the header of RFC 6266 for a download: `filename` is the ASCII fallback,
 * without the characters that would break the parameter, and `filename*` keeps
 * the original name, percent-encoded as RFC 5987 requires.
 */
export function attachmentDisposition(filename: string): string {
  return `attachment; filename="${toAsciiFilename(filename)}"; filename*=UTF-8''${toExtendedValue(filename)}`;
}
