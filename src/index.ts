// Protomux JS Client Library
// Public API: ProtomuxClient, ProtomuxError, Envelope, and related types

// ============================================================================
// Type Declarations & Ambient Globals
// ============================================================================

// Minimal ambient Node globals (optional) to avoid requiring @types/node for library consumers
// when bundling in environments where process/require exist. They are declared loose to not
// interfere with real typings if present.
declare const process: { release?: { name?: string } } | undefined;
declare function require(name: string): unknown;

// ============================================================================
// Public Interfaces & Types
// ============================================================================

export interface Envelope {
  version: number;
  flags: number;
  cid: number;
  typeName: string;
  payload: Uint8Array;
}

export interface ProtomuxClientOptions {
  timeoutMs?: number;
  protocol?: string;
  WebSocketImpl?: typeof WebSocket;
  headers?: Record<string, string>; // optional HTTP headers for initial WebSocket upgrade (Node environments)
  openTimeoutMs?: number; // time to wait for websocket open before rejecting
  onOpen?: () => void; // optional hook when connection opens
  onError?: (err: ProtomuxError, env: Envelope) => void; // global error hook (push-level or unhandled)
  onClose?: (info: { code: number; reason: string; wasClean: boolean }) => void; // invoked when websocket closes
  onReconnect?: (attempt: number) => void; // optional hook when reconnection is attempted
}

export interface WireErrorDetail {
  type: string;
  data: Uint8Array;
}

export interface WireError {
  code: number;
  message: string;
  details: WireErrorDetail[];
}

// Protobuf codec interfaces (ts-proto style)
export interface TsProtoEncoder<T> {
  encode(message: T, writer?: unknown): { finish(): Uint8Array };
}

export interface TsProtoDecoder<T> {
  decode(input: Uint8Array, length?: number): T;
}

// ============================================================================
// Private Interfaces
// ============================================================================

interface Pending {
  resolve: (v: Uint8Array) => void;
  reject: (e: unknown) => void;
}

// ============================================================================
// Constants
// ============================================================================

const VERSION = 1;

// Flags (mirror server). Only subset needed by client helpers.
const FlagError = 0x02;
const FlagCancel = 0x20;
const FlagDeadline = 0x40;

// Correlation id generator
let nextCID = 1;

// ============================================================================
// Utility Functions - Varint Encoding/Decoding
// ============================================================================

function encodeVarint(value: number): Uint8Array {
  const bytes: number[] = [];
  let v = value >>> 0;
  while (v >= 0x80) {
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  bytes.push(v);
  return new Uint8Array(bytes);
}

function decodeVarint(view: DataView, offset: number): [number, number] {
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
// Utility Functions - Envelope Encoding/Decoding
// ============================================================================

function encodeEnvelope(cid: number, typeName: string, payload: Uint8Array, flags = 0): Uint8Array {
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

function decodeEnvelope(buf: ArrayBuffer): Envelope {
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
// Utility Functions - Error Decoding
// ============================================================================

function decodeWireError(payload: Uint8Array): WireError {
  // Mirrors server layout: code(varint) | msgLen | msg | detailsCount | repeated(typeLen|type|dataLen|data)
  let off = 0;
  const readVar = (): number => {
    let shift = 0,
      res = 0;
    while (true) {
      if (off >= payload.length) throw new Error('varint eof');
      const b = payload[off++];
      res |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
    }
    return res >>> 0;
  };
  const code = readVar();
  const msgLen = readVar();
  if (off + msgLen > payload.length) throw new Error('msgLen out of range');
  const message = new TextDecoder().decode(payload.subarray(off, off + msgLen));
  off += msgLen;
  if (off === payload.length) return { code, message, details: [] };
  const count = readVar();
  const details: WireErrorDetail[] = [];
  for (let i = 0; i < count; i++) {
    const tLen = readVar();
    if (off + tLen > payload.length) throw new Error('type len OOR');
    const type = new TextDecoder().decode(payload.subarray(off, off + tLen));
    off += tLen;
    const dLen = readVar();
    if (off + dLen > payload.length) throw new Error('detail len OOR');
    const data = payload.subarray(off, off + dLen);
    off += dLen;
    details.push({ type, data });
  }
  return { code, message, details };
}

// ============================================================================
// Utility Functions - Helpers
// ============================================================================

function allocCID(): number {
  return nextCID++;
}

function resolveWS(opts: ProtomuxClientOptions): unknown {
  if (opts.WebSocketImpl) return opts.WebSocketImpl;
  const isNode =
    typeof process !== 'undefined' && !!process?.release?.name && process.release.name === 'node';

  // Helper to try loading 'ws' via require
  const tryRequireWS = (): typeof WebSocket | null => {
    if (typeof require === 'undefined') return null;
    try {
      const mod = require('ws') as
        | typeof WebSocket
        | { default: typeof WebSocket; [key: string]: unknown };
      if (mod && typeof mod === 'object' && 'default' in mod) {
        return mod.default;
      }
      return mod;
    } catch {
      return null;
    }
  };

  // If headers requested in Node, prefer 'ws' explicitly (since browser WebSocket can't take headers).
  if (isNode && opts.headers) {
    const ws = tryRequireWS();
    if (ws) return ws;
    // If we couldn't load ws but headers are needed, throw a helpful error
    throw new Error("Custom headers require the 'ws' package. Install it with: npm install ws");
  }

  if ((globalThis as unknown as { WebSocket?: typeof WebSocket }).WebSocket)
    return (globalThis as unknown as { WebSocket?: typeof WebSocket }).WebSocket;

  if (isNode) {
    const ws = tryRequireWS();
    if (ws) return ws;
  }

  throw new Error(
    "No WebSocket implementation available (tried global and 'ws'). Install 'ws' or supply WebSocketImpl."
  );
}

// ============================================================================
// Error Class
// ============================================================================

export class ProtomuxError extends Error {
  constructor(
    public code: number,
    message: string,
    public details: WireErrorDetail[]
  ) {
    super(message);
    this.name = 'ProtomuxError';
  }
}

// ============================================================================
// Main Client Class
// ============================================================================

export class ProtomuxClient {
  private ws: WebSocket;
  private pending = new Map<number, Pending>();
  private openPromise: Promise<void>;
  private timeoutMs: number;
  private pushHandlers: ((env: Envelope) => void)[] = [];
  private typeHandlers: Map<string, Set<(payload: Uint8Array, env: Envelope) => void>> = new Map();
  private openHandlers: (() => void)[] = [];
  private closeHandlers: ((ev: { code: number; reason: string; wasClean: boolean }) => void)[] = [];
  private errorHandlers: ((ev: Event) => void)[] = [];

  constructor(
    private url: string,
    private opts: ProtomuxClientOptions = {}
  ) {
    this.timeoutMs = opts.timeoutMs ?? 5000;
    const proto = opts.protocol ?? 'protomux.v1';
    const WSImpl = resolveWS(opts) as typeof WebSocket;
    // If headers provided and ws implementation supports passing options (like 'ws' in Node), forward them.
    // The 'ws' package accepts a third parameter for options including headers.
    const wsOptions: Record<string, unknown> = opts.headers ? { headers: opts.headers } : {};
    // Type cast necessary as 'ws' package accepts 3 args but browser WebSocket only accepts 2
    this.ws = new (WSImpl as new (url: string, proto: string, options?: unknown) => WebSocket)(
      url,
      proto,
      wsOptions
    );
    this.ws.binaryType = 'arraybuffer';
    this.ws.onmessage = (ev: MessageEvent) => this.handleMessage(ev.data as ArrayBuffer);
    this.ws.onopen = () => {
      for (const fn of this.openHandlers) {
        try {
          fn();
        } catch {
          // Ignore errors from user-provided handlers
        }
      }
    };
    this.ws.onerror = (ev: Event) => {
      for (const fn of this.errorHandlers) {
        try {
          fn(ev);
        } catch {
          // Ignore errors from user-provided handlers
        }
      }
    };
    this.ws.onclose = (ev: CloseEvent) => {
      // reject all pending
      for (const [_cid, p] of this.pending.entries()) {
        p.reject(new Error('connection closed'));
      }
      this.pending.clear();
      const info = {
        code: typeof ev.code === 'number' ? ev.code : 0,
        reason: ev.reason || '',
        wasClean: !!ev.wasClean,
      };
      for (const fn of this.closeHandlers) {
        try {
          fn(info);
        } catch {
          // Ignore errors from user-provided handlers
        }
      }
      if (opts.onClose) {
        try {
          opts.onClose(info);
        } catch {
          /* ignore user callback errors */
        }
      }
    };
    const openTimeout = opts.openTimeoutMs ?? 3000;
    this.openPromise = new Promise((res, rej) => {
      const to = setTimeout(() => {
        rej(new Error('websocket open timeout'));
      }, openTimeout);
      this.ws.addEventListener(
        'open',
        () => {
          clearTimeout(to);
          if (opts.onOpen) {
            try {
              opts.onOpen();
            } catch {
              // Ignore errors from user-provided onOpen callback
            }
          }
          res();
        },
        { once: true }
      );
      this.ws.addEventListener(
        'error',
        (ev: Event & { error?: unknown }) => {
          clearTimeout(to);
          const errorObj = (ev as unknown as { error?: unknown })?.error;
          rej(errorObj instanceof Error ? errorObj : new Error('websocket error'));
        },
        { once: true }
      );
    });
  }

  // ============================================================================
  // WebSocket Lifecycle Methods
  // ============================================================================

  get readyState(): number {
    return this.ws.readyState;
  }

  close(): void {
    this.ws.close();
  }

  // ============================================================================
  // Private Message Handling
  // ============================================================================

  private handleMessage(data: ArrayBuffer): void {
    try {
      const env = decodeEnvelope(data);
      const isError = (env.flags & FlagError) !== 0 || env.typeName === 'error';
      if (env.cid !== 0) {
        const p = this.pending.get(env.cid);
        if (p) {
          this.pending.delete(env.cid);
          if (isError) {
            try {
              const we = decodeWireError(env.payload);
              p.reject(new ProtomuxError(we.code, we.message, we.details));
            } catch (e) {
              p.reject(e instanceof Error ? e : new Error(String(e)));
            }
          } else {
            p.resolve(env.payload);
          }
        }
      } else {
        if (isError) {
          try {
            const we = decodeWireError(env.payload);
            const err = new ProtomuxError(we.code, we.message, we.details);
            if (this.opts.onError) this.opts.onError(err, env);
          } catch {
            // Ignore malformed error messages
          }
        } else {
          // push frame
          for (const fn of this.pushHandlers) {
            try {
              fn(env);
            } catch {
              // Isolate errors from individual push handlers
            }
          }
          this.emitType(env);
        }
      }
    } catch {
      // Ignore malformed messages
    }
  }

  private emitType(env: Envelope): void {
    const set = this.typeHandlers.get(env.typeName);
    if (set) {
      for (const fn of set) {
        try {
          fn(env.payload, env);
        } catch {
          // Isolate errors from individual type handlers
        }
      }
    }
  }

  // ============================================================================
  // Private Request Methods
  // ============================================================================

  private async request(typeName: string, payload: Uint8Array): Promise<Uint8Array> {
    return this.requestEx({ typeName, payload });
  }

  private async requestEx(opts: {
    typeName: string;
    payload: Uint8Array;
    timeoutMs?: number;
    deadlineMs?: number;
    signal?: AbortSignal;
  }): Promise<Uint8Array> {
    await this.openPromise;
    const cid = allocCID();
    let flags = 0;
    let body = opts.payload;
    if (opts.deadlineMs && opts.deadlineMs > 0) {
      flags |= FlagDeadline;
      const dlPrefix = encodeVarint(opts.deadlineMs >>> 0);
      const merged = new Uint8Array(dlPrefix.length + body.length);
      merged.set(dlPrefix, 0);
      merged.set(body, dlPrefix.length);
      body = merged;
    }
    const timeout = opts.timeoutMs ?? this.timeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(cid);
        reject(new Error('request timeout'));
      }, timeout);
      const pending: Pending = {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e instanceof Error ? e : new Error(String(e)));
        },
      };
      this.pending.set(cid, pending);
      if (opts.signal) {
        if (opts.signal.aborted) {
          this.pending.delete(cid);
          clearTimeout(timer);
          reject(new Error('aborted'));
          return;
        }
        const abortHandler = () => {
          // send cancel frame
          try {
            this.ws.send(encodeEnvelope(cid, opts.typeName, new Uint8Array(), FlagCancel));
          } catch {
            // Ignore send errors when canceling
          }
          this.pending.delete(cid);
          clearTimeout(timer);
          reject(new Error('aborted'));
        };
        opts.signal.addEventListener('abort', abortHandler, { once: true });
      }
      this.ws.send(encodeEnvelope(cid, opts.typeName, body, flags));
    });
  }

  // ============================================================================
  // Public API - Event Handlers
  // ============================================================================

  /**
   * Register a handler for raw push messages.
   */
  onPush(fn: (env: Envelope) => void): void {
    this.pushHandlers.push(fn);
  }

  /**
   * Register a handler for a specific message type.
   * Returns an unsubscribe function.
   */
  on(typeName: string, fn: (payload: Uint8Array, env: Envelope) => void): () => void {
    let set = this.typeHandlers.get(typeName);
    if (!set) {
      set = new Set();
      this.typeHandlers.set(typeName, set);
    }
    set.add(fn);
    return () => {
      set.delete(fn);
      if (set.size === 0) this.typeHandlers.delete(typeName);
    };
  }

  /**
   * Register a typed message handler with auto-decode.
   * Example: client.onMessage('examples.chat.MessageEvent', ChatMessageEvent, (msg) => {...})
   */
  onMessage<T>(
    typeName: string,
    decoder: TsProtoDecoder<T>,
    handler: (msg: T) => void
  ): () => void {
    return this.on(typeName, (bytes) => {
      try {
        handler(decoder.decode(bytes));
      } catch {
        // Swallow decode errors
      }
    });
  }

  /**
   * Register a handler for WebSocket open event.
   */
  onOpen(handler: () => void): () => void {
    this.openHandlers.push(handler);
    return () => {
      const idx = this.openHandlers.indexOf(handler);
      if (idx >= 0) this.openHandlers.splice(idx, 1);
    };
  }

  /**
   * Register a handler for WebSocket close event.
   */
  onClose(
    handler: (info: { code: number; reason: string; wasClean: boolean }) => void
  ): () => void {
    this.closeHandlers.push(handler);
    return () => {
      const idx = this.closeHandlers.indexOf(handler);
      if (idx >= 0) this.closeHandlers.splice(idx, 1);
    };
  }

  /**
   * Register a handler for WebSocket error event.
   */
  onError(handler: (ev: Event) => void): () => void {
    this.errorHandlers.push(handler);
    return () => {
      const idx = this.errorHandlers.indexOf(handler);
      if (idx >= 0) this.errorHandlers.splice(idx, 1);
    };
  }

  // ============================================================================
  // Public API - Messaging
  // ============================================================================

  /**
   * Send a fire-and-forget message (no response expected).
   */
  async sendFireAndForget(typeName: string, payload: Uint8Array): Promise<void> {
    await this.openPromise;
    const frame = encodeEnvelope(allocCID(), typeName, payload);
    this.ws.send(frame);
  }

  /**
   * Send a raw request/response (no protobuf encoding).
   * Example: const res = await client.sendRaw("status", new Uint8Array());
   */
  async sendRaw(
    typeName: string,
    payload: Uint8Array,
    opts?: { timeoutMs?: number; deadlineMs?: number; signal?: AbortSignal }
  ): Promise<Uint8Array> {
    return this.requestEx({ typeName, payload, ...opts });
  }

  /**
   * Send a typed RPC call with protobuf codecs.
   * Example: const res = await client.send('examples.book.ListBooksRequest', {}, ListBooksRequest, ListBooksResponse);
   */
  async send<TReq, TRes>(
    typeName: string,
    req: TReq,
    reqCodec: TsProtoEncoder<TReq>,
    resCodec: TsProtoDecoder<TRes>,
    opts?: { timeoutMs?: number; deadlineMs?: number; signal?: AbortSignal }
  ): Promise<TRes> {
    const bytes = reqCodec.encode(req).finish();
    const resBytes = await this.requestEx({
      typeName,
      payload: bytes,
      ...opts,
    });
    return resCodec.decode(resBytes);
  }

  // ============================================================================
  // Public API - Pub/Sub
  // ============================================================================

  /**
   * Subscribe to a topic. Returns an unsubscribe function.
   */
  async subscribe(topic: string): Promise<() => Promise<void>> {
    const enc = new TextEncoder().encode(topic);
    await this.sendFireAndForget('protomux.subscribe', enc);
    return async () => {
      await this.sendFireAndForget('protomux.unsubscribe', enc);
    };
  }
}
