import { attachmentDisposition } from './content-disposition.util';

const HEADER_FORMAT =
  /^attachment; filename="([^"]*)"; filename\*=UTF-8''(.+)$/;
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;
const ATTR_CHARS = /^(?:%[0-9A-F]{2}|[A-Za-z0-9!#$&+\-.^_`|~])+$/;

function parts(filename: string): { ascii: string; extended: string } {
  const match = HEADER_FORMAT.exec(attachmentDisposition(filename));
  expect(match).not.toBeNull();
  return { ascii: match![1], extended: match![2] };
}

describe('attachmentDisposition', () => {
  it('should keep a plain name in both parameters', () => {
    expect(attachmentDisposition('aula.mp4')).toBe(
      `attachment; filename="aula.mp4"; filename*=UTF-8''aula.mp4`,
    );
  });

  it('should keep the spaces of the name in the ASCII parameter', () => {
    const { ascii, extended } = parts('minha aula.mp4');

    expect(ascii).toBe('minha aula.mp4');
    expect(extended).toBe('minha%20aula.mp4');
  });

  it('should take the quotes out of the ASCII parameter and encode them in the other', () => {
    const { ascii, extended } = parts('a"b".mp4');

    expect(ascii).toBe('a_b_.mp4');
    expect(extended).toBe('a%22b%22.mp4');
  });

  it.each([
    ['line feed', 'a\nb.mp4', 'a%0Ab.mp4'],
    ['carriage return and line feed', 'a\r\nb.mp4', 'a%0D%0Ab.mp4'],
  ])('should not let a %s reach the header', (_case, filename, extended) => {
    const header = attachmentDisposition(filename);

    expect(header).not.toMatch(/[\r\n]/);
    expect(parts(filename).extended).toBe(extended);
  });

  it('should keep a forged header out of the header', () => {
    const header = attachmentDisposition('a.mp4\r\nSet-Cookie: x=1');

    expect(header).not.toMatch(/[\r\n]/);
    expect(parts('a.mp4\r\nSet-Cookie: x=1').ascii).toBe(
      'a.mp4__Set-Cookie: x=1',
    );
  });

  it('should preserve the accents in the encoded parameter only', () => {
    const { ascii, extended } = parts('ação.mp4');

    expect(ascii).toBe('a__o.mp4');
    expect(extended).toBe('a%C3%A7%C3%A3o.mp4');
    expect(decodeURIComponent(extended)).toBe('ação.mp4');
  });

  it('should not split the header on a semicolon', () => {
    const { ascii, extended } = parts('a;b=c.mp4');

    expect(ascii).toBe('a_b=c.mp4');
    expect(extended).toBe('a%3Bb%3Dc.mp4');
  });

  it('should not leave a percent sequence that a client could decode in the ASCII parameter', () => {
    const { ascii, extended } = parts('50%41.mp4');

    expect(ascii).toBe('50_41.mp4');
    expect(extended).toBe('50%2541.mp4');
    expect(decodeURIComponent(extended)).toBe('50%41.mp4');
  });

  it('should take the backslash out of the ASCII parameter', () => {
    expect(parts('a\\b.mp4').ascii).toBe('a_b.mp4');
  });

  it('should replace a character outside the basic plane once in the ASCII parameter', () => {
    const { ascii, extended } = parts('🎬.mp4');

    expect(ascii).toBe('_.mp4');
    expect(decodeURIComponent(extended)).toBe('🎬.mp4');
  });

  it('should encode what encodeURIComponent leaves and RFC 5987 does not allow', () => {
    const { extended } = parts("it's (a)*.mp4");

    expect(extended).toBe('it%27s%20%28a%29%2A.mp4');
    expect(decodeURIComponent(extended)).toBe("it's (a)*.mp4");
  });

  it.each([
    ['a plain name', 'aula.mp4'],
    ['every awkward character', 'a"b\r\nc;d\\e%41ação\'(f)*🎬.mp4'],
    ['the longest name the API accepts', '語'.repeat(251) + '.mp4'],
  ])(
    'should give a valid header that decodes to the same name, for %s',
    (_case, name) => {
      const { ascii, extended } = parts(name);

      expect(attachmentDisposition(name)).toMatch(PRINTABLE_ASCII);
      expect(ascii).toMatch(PRINTABLE_ASCII);
      expect(extended).toMatch(ATTR_CHARS);
      expect(decodeURIComponent(extended)).toBe(name);
    },
  );
});
