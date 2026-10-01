import { MAX_MESSAGE, PilotError } from '../shared.js';
export function encodeMessage(message: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(message));
  if (payload.length > MAX_MESSAGE) throw new PilotError('message_too_large');
  const size = Buffer.alloc(4); size.writeUInt32LE(payload.length); return Buffer.concat([size,payload]);
}
export class NativeDecoder {
  private buffer: Buffer = Buffer.alloc(0);
  push(data: Buffer): unknown[] {
    this.buffer = Buffer.concat([this.buffer,data]); const messages: unknown[] = [];
    while (this.buffer.length>=4) {
      const size = this.buffer.readUInt32LE(0);
      if (!size || size > MAX_MESSAGE) throw new PilotError('message_too_large');
      if (this.buffer.length < size+4) break;
      messages.push(JSON.parse(this.buffer.subarray(4,4+size).toString('utf8')));
      this.buffer = this.buffer.subarray(4+size);
    }
    return messages;
  }
}
