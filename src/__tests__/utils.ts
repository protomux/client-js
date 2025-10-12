// Test utilities for Protomux client tests
import { WebSocket, WebSocketServer } from 'ws';
import type { AddressInfo } from 'net';

// ============================================================================
// Constants (mirrored from main code)
// ============================================================================

const VERSION = 1;
const FlagError = 0x02;

// ============================================================================
// Varint Encoding/Decoding (for server-side test helpers)
// ============================================================================

export function encodeVarint(value: number): Uint8Array {
  const bytes: number[] = [];
  let v = value >>> 0;
  while (v >= 0x80) {
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  bytes.push(v);
  return new Uint8Array(bytes);
}

export function decodeVarint(view: DataView, offset: number): [number, number] {
  let result = 0;
  let shift = 0;
  let pos = offset;
  while (true) {
    if (pos >= view.byteLength) throw new Error('varint overflow');
    const b = view.getUint8(pos++);
    result |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  return [result, pos];
}

// ============================================================================
// Envelope Encoding/Decoding
// ============================================================================

export interface Envelope {
  version: number;
  flags: number;
  cid: number;
  typeName: string;
  payload: Uint8Array;
}

export function encodeEnvelope(
  cid: number,
  typeName: string,
  payload: Uint8Array,
  flags = 0
): Uint8Array {
  const typeBytes = new TextEncoder().encode(typeName);
  const parts: Uint8Array[] = [
    Uint8Array.of(VERSION),
    Uint8Array.of(flags & 0xff),
    encodeVarint(cid),
    encodeVarint(typeBytes.length),
    typeBytes,
    encodeVarint(payload.length),
    payload,
  ];
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function decodeEnvelope(buf: ArrayBuffer): Envelope {
  const view = new DataView(buf);
  let offset = 0;
  const version = view.getUint8(offset++);
  const flags = view.getUint8(offset++);
  const [cid, o1] = decodeVarint(view, offset);
  offset = o1;
  const [typeLen, o2] = decodeVarint(view, offset);
  offset = o2;
  const typeBytes = new Uint8Array(buf, offset, typeLen);
  offset += typeLen;
  const [payloadLen, o3] = decodeVarint(view, offset);
  offset = o3;
  const payload = new Uint8Array(buf, offset, payloadLen);
  return {
    version,
    flags,
    cid,
    typeName: new TextDecoder().decode(typeBytes),
    payload,
  };
}

// ============================================================================
// Error Encoding (for mock server)
// ============================================================================

export interface WireErrorDetail {
  type: string;
  data: Uint8Array;
}

export function encodeWireError(
  code: number,
  message: string,
  details: WireErrorDetail[] = []
): Uint8Array {
  const msgBytes = new TextEncoder().encode(message);
  const parts: Uint8Array[] = [encodeVarint(code), encodeVarint(msgBytes.length), msgBytes];

  parts.push(encodeVarint(details.length));
  for (const d of details) {
    const typeBytes = new TextEncoder().encode(d.type);
    parts.push(encodeVarint(typeBytes.length));
    parts.push(typeBytes);
    parts.push(encodeVarint(d.data.length));
    parts.push(d.data);
  }

  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// ============================================================================
// Mock WebSocket Server
// ============================================================================

export type MessageHandler = (ws: WebSocket, env: Envelope) => void;

export class MockProtomuxServer {
  private wss: WebSocketServer;
  private handlers = new Map<string, MessageHandler>();
  public url: string;
  public clients = new Set<WebSocket>();

  constructor(public port = 0) {
    this.wss = new WebSocketServer({ port });
    const addr = this.wss.address() as AddressInfo;
    this.url = `ws://localhost:${addr.port}`;

    this.wss.on('connection', (ws: WebSocket) => {
      this.clients.add(ws);
      ws.on('message', (data: Buffer) => {
        try {
          const arrayBuffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
          const env = decodeEnvelope(arrayBuffer);
          const handler = this.handlers.get(env.typeName);
          if (handler) {
            handler(ws, env);
          }
        } catch (err) {
          console.error('Mock server error:', err);
        }
      });

      ws.on('close', () => {
        this.clients.delete(ws);
      });
    });
  }

  /**
   * Register a handler for a specific message type.
   */
  on(typeName: string, handler: MessageHandler): void {
    this.handlers.set(typeName, handler);
  }

  /**
   * Send a push message (cid=0) to all connected clients.
   */
  push(typeName: string, payload: Uint8Array): void {
    const frame = encodeEnvelope(0, typeName, payload);
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(frame);
      }
    }
  }

  /**
   * Send a response back to the client.
   */
  reply(ws: WebSocket, cid: number, typeName: string, payload: Uint8Array, isError = false): void {
    const flags = isError ? FlagError : 0;
    const frame = encodeEnvelope(cid, typeName, payload, flags);
    ws.send(frame);
  }

  /**
   * Send an error response.
   */
  replyError(
    ws: WebSocket,
    cid: number,
    code: number,
    message: string,
    details: WireErrorDetail[] = []
  ): void {
    const payload = encodeWireError(code, message, details);
    this.reply(ws, cid, 'error', payload, true);
  }

  /**
   * Close the server.
   */
  async close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.wss.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /**
   * Wait for a client connection.
   */
  waitForConnection(): Promise<WebSocket> {
    return new Promise((resolve) => {
      if (this.clients.size > 0) {
        resolve([...this.clients][0]);
      } else {
        this.wss.once('connection', (ws) => resolve(ws));
      }
    });
  }
}

// ============================================================================
// Test Helper Functions
// ============================================================================

/**
 * Create a simple protobuf-like encoder/decoder for testing.
 */
export function createMockCodec<T>() {
  return {
    encode: (msg: T) => ({
      finish: () => new TextEncoder().encode(JSON.stringify(msg)),
    }),
    decode: (data: Uint8Array): T => JSON.parse(new TextDecoder().decode(data)) as T,
  };
}

/**
 * Wait for a condition with timeout.
 */
export function waitFor(
  condition: () => boolean,
  timeoutMs = 1000,
  checkIntervalMs = 10
): Promise<void> {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const check = () => {
      if (condition()) {
        resolve();
      } else if (Date.now() - startTime > timeoutMs) {
        reject(new Error('waitFor timeout'));
      } else {
        setTimeout(check, checkIntervalMs);
      }
    };
    check();
  });
}

/**
 * Sleep for a given duration.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
