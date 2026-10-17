export const MAX_HELPER_FRAME = 1_000_000;
export const MAX_EXTENSION_FRAME = 64 * 1024 * 1024;

export function encodeFrame(value: unknown, maxLength = MAX_EXTENSION_FRAME): Buffer {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  if (body.length > maxLength) throw new Error('native message is too large');
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

export class NativeFrameDecoder {
  private buffer = Buffer.alloc(0);
  constructor(private readonly maxLength = MAX_EXTENSION_FRAME) {}

  push(chunk: Buffer | Uint8Array): unknown[] {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    const messages: unknown[] = [];
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length > this.maxLength)
        throw new Error(`native message exceeds ${this.maxLength} bytes`);
      if (this.buffer.length < length + 4) break;
      const body = this.buffer.subarray(4, length + 4);
      this.buffer = this.buffer.subarray(length + 4);
      messages.push(JSON.parse(body.toString('utf8')));
    }
    return messages;
  }
}
