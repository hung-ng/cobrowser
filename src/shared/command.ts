export function shellCommandArg(value: unknown): string {
  const text = String(value).replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ');
  if (/^[a-zA-Z0-9._/:=-]+$/.test(text)) return text;
  return `'${text.replaceAll("'", "'\\''")}'`;
}
