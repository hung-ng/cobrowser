declare const COBROWSER_VERSION: string | undefined;

export const VERSION = typeof COBROWSER_VERSION === 'string' ? COBROWSER_VERSION : '0.1.0';
export const PROTOCOL_VERSION = 1;
export const MAX_CHARS = 20_000;
/** Keep screenshot transport payloads bounded while allowing the CLI to save images. */
export const MAX_SCREENSHOT_CHARS = 80 * 1024 * 1024;
/** Maximum URL length carried by the helper's final tab identity guard. */
export const MAX_GUARD_URL_CHARS = 16_384;
export const PUBLIC_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAqJWdWibzQIzXo5xcHmV8EbYE9e3c59mkXh1kMTp1p9AEqoQKoHKdD5mlsdTrGYsDNHEpd0CVD5t4TK09AsygqOxJwIuSDp1AdsbIMB674jgqbfYUZZaQ/dIBbQDcQOdOUqtHguDng4Gscxp5nSeVlIlx1xkrlGVwIrE5cKPM/RmRSDLSg7+eYl2tVkd+EUqiyElg54E7aLHTt8eer+SxicTYVVfF/cqwuhG+wQlWdXI+zy6PUWOzFEiqNkxEEvITBGKHvWbt6Y+4EXm7h9t9y8gxtneRd68U3g9zjseusSYy7nABRFNwWKusbBzm9lNCNlz0LG9EfNs3iJRGTxaZNwIDAQAB';
export const EXTENSION_ID = 'laeencopealhcofijafpfkicblippbnp';
export const NATIVE_HOST = 'cobrowser';

const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

export function normalizeErrorCode(value: unknown, fallback = 'ERROR'): string {
  const safeFallback = ERROR_CODE.test(fallback) ? fallback : 'ERROR';
  if (typeof value !== 'string') return safeFallback;
  return ERROR_CODE.test(value) ? value : safeFallback;
}
