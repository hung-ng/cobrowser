export const MAX_HELPER_FRAME = 1_000_000;
export const MAX_EXTENSION_FRAME = 64 * 1024 * 1024;

export function encodeFrame(value: unknown, maxLength = MAX_EXTENSION_FRAME): Buffer {
  const serialized = JSON.stringify(value);
  if (typeof serialized !== 'string') throw new Error('native message must be JSON-serializable');
  const body = Buffer.from(serialized, 'utf8');
  if (body.length > maxLength) throw new Error('native message is too large');
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

export class NativeFrameDecoder {
  private header = Buffer.alloc(4);
  private headerSize = 0;
  private chunks: Buffer[] = [];
  private bodySize = 0;
  private bodyLength = 0;
  constructor(private readonly maxLength = MAX_EXTENSION_FRAME) {}

  push(chunk: Buffer | Uint8Array): unknown[] {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const messages: unknown[] = [];
    let offset = 0;
    while (offset < bytes.length) {
      if (this.headerSize < 4) {
        const take = Math.min(4 - this.headerSize, bytes.length - offset);
        bytes.copy(this.header, this.headerSize, offset, offset + take);
        this.headerSize += take;
        offset += take;
        if (this.headerSize < 4) break;
        this.bodyLength = this.header.readUInt32LE(0);
        if (this.bodyLength > this.maxLength)
          throw new Error(`native message exceeds ${this.maxLength} bytes`);
        if (!this.bodyLength) throw new Error('native message must contain JSON');
      }
      const take = Math.min(this.bodyLength - this.bodySize, bytes.length - offset);
      if (take) this.chunks.push(Buffer.from(bytes.subarray(offset, offset + take)));
      this.bodySize += take;
      offset += take;
      if (this.bodySize < this.bodyLength) break;
      const body = Buffer.concat(this.chunks, this.bodyLength);
      this.chunks = [];
      this.bodySize = 0;
      this.bodyLength = 0;
      this.headerSize = 0;
      messages.push(JSON.parse(body.toString('utf8')));
    }
    return messages;
  }
}
