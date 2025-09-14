// Protomux JS Client Library
// Public API: ProtomuxClient, encodeEnvelope, decodeEnvelope

// Minimal ambient Node globals (optional) to avoid requiring @types/node for library consumers
// when bundling in environments where process/require exist. They are declared loose to not
// interfere with real typings if present.
// Minimal loose declarations (avoid 'any'); using unknown where unavoidable.
declare const process: { release?: { name?: string } } | undefined;
declare function require(name: string): unknown;

const VERSION = 1;

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
    if (pos >= view.byteLength) throw new Error("varint overflow");
    const b = view.getUint8(pos++);
    result |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  return [result, pos];
}

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

export interface Pending {
  resolve: (v: Uint8Array) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  reject: (e: unknown) => void;
}

export interface ProtomuxClientOptions {
  timeoutMs?: number;
  protocol?: string;
  WebSocketImpl?: typeof WebSocket;
  headers?: Record<string, string>; // optional HTTP headers for initial WebSocket upgrade (Node environments)
  openTimeoutMs?: number; // time to wait for websocket open before rejecting
  onOpen?: () => void; // optional hook when connection opens
}

export class ProtomuxClient {
  private ws: WebSocket;
  private pending = new Map<number, Pending>();
  private openPromise: Promise<void>;
  private timeoutMs: number;
  private pushHandlers: ((env: Envelope) => void)[] = [];
  private typeHandlers: Map<
    string,
    Set<(payload: Uint8Array, env: Envelope) => void>
  > = new Map();

  constructor(private url: string, opts: ProtomuxClientOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? 5000;
    const proto = opts.protocol ?? "protomux.v1";
    const WSImpl = resolveWS(opts) as typeof WebSocket;
    // If headers provided and ws implementation supports passing options (like 'ws' in Node), forward them.
    // Simplified: always call with (url, proto); Node 'ws' accepts second protocols arg.
    this.ws = new WSImpl(url, proto);
    (this.ws as WebSocket).binaryType = "arraybuffer";
    this.ws.onmessage = (ev: MessageEvent) =>
      this.onMessage(ev.data as ArrayBuffer);
    this.ws.onopen = () => {
      /* optional hook */
    };
    this.ws.onerror = () => {
      /* swallow; surfaced via pending timeouts */
    };
    this.ws.onclose = () => {
      // reject all pending
      for (const [cid, p] of this.pending.entries()) {
        p.reject(new Error("connection closed"));
      }
      this.pending.clear();
    };
    const openTimeout = opts.openTimeoutMs ?? 3000;
    this.openPromise = new Promise((res, rej) => {
      const to = setTimeout(() => {
        rej(new Error("websocket open timeout"));
      }, openTimeout);
      this.ws.addEventListener(
        "open",
        () => {
          clearTimeout(to);
          if (opts.onOpen) {
            try {
              opts.onOpen();
            } catch {}
          }
          res();
        },
        { once: true }
      );
      this.ws.addEventListener(
        "error",
        (ev: Event & { error?: unknown }) => {
          clearTimeout(to);
          rej(
            (ev as unknown as { error?: unknown })?.error ||
              new Error("websocket error")
          );
        },
        { once: true }
      );
    });
  }

  private onMessage(data: ArrayBuffer) {
    try {
      const env = decodeEnvelope(data);
      if (env.cid !== 0) {
        const p = this.pending.get(env.cid);
        if (p) {
          this.pending.delete(env.cid);
          p.resolve(env.payload);
        }
      } else {
        // push frame
        for (const fn of this.pushHandlers) {
          try {
            fn(env);
          } catch {
            /* isolate */
          }
        }
        this.emitType(env);
      }
    } catch (e) {
      // ignore
    }
  }

  async request(typeName: string, payload: Uint8Array): Promise<Uint8Array> {
    await this.openPromise;
    const cid = allocCID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(cid);
        reject(new Error("request timeout"));
      }, this.timeoutMs);
      this.pending.set(cid, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      const frame = encodeEnvelope(cid, typeName, payload);
      this.ws.send(frame);
    });
  }

  get readyState(): number {
    return this.ws.readyState;
  }
  close() {
    this.ws.close();
  }

  onPush(fn: (env: Envelope) => void) {
    this.pushHandlers.push(fn);
  }

  on(typeName: string, fn: (payload: Uint8Array, env: Envelope) => void) {
    let set = this.typeHandlers.get(typeName);
    if (!set) {
      set = new Set();
      this.typeHandlers.set(typeName, set);
    }
    set.add(fn);
    return () => {
      set!.delete(fn);
      if (set!.size === 0) this.typeHandlers.delete(typeName);
    };
  }

  private emitType(env: Envelope) {
    const set = this.typeHandlers.get(env.typeName);
    if (set) {
      for (const fn of set) {
        try {
          fn(env.payload, env);
        } catch {}
      }
    }
  }

  async rawSend(typeName: string, payload: Uint8Array): Promise<void> {
    await this.openPromise;
    const frame = encodeEnvelope(allocCID(), typeName, payload);
    this.ws.send(frame);
  }

  async send(typeName: string, payload: Uint8Array): Promise<void> {
    return this.rawSend(typeName, payload);
  }

  async requestProto<TRes>(
    inType: string,
    reqBytes: Uint8Array,
    decode: (bytes: Uint8Array) => TRes
  ): Promise<TRes> {
    const bytes = await this.request(inType, reqBytes);
    return decode(bytes);
  }

  async subscribe(topic: string): Promise<() => void> {
    const enc = new TextEncoder().encode(topic);
    await this.rawSend("protomux.subscribe", enc);
    return async () => {
      await this.rawSend("protomux.unsubscribe", enc);
    };
  }
}

// Correlation id generator
let nextCID = 1;
function allocCID() {
  return nextCID++;
}

function resolveWS(opts: ProtomuxClientOptions): unknown {
  if (opts.WebSocketImpl) return opts.WebSocketImpl;
  const isNode =
    typeof process !== "undefined" &&
    !!process?.release?.name &&
    process.release!.name === "node";
  // If headers requested in Node, prefer 'ws' explicitly (since browser WebSocket can't take headers).
  if (isNode && opts.headers) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require("ws") as unknown;
      if (mod && typeof mod === "object" && "default" in (mod as any)) {
        return (mod as any).default as typeof WebSocket;
      }
      return mod as typeof WebSocket;
    } catch {
      /* fallback */
    }
  }
  if ((globalThis as unknown as { WebSocket?: typeof WebSocket }).WebSocket)
    return (globalThis as unknown as { WebSocket?: typeof WebSocket })
      .WebSocket;
  if (isNode) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require("ws") as unknown;
      if (mod && typeof mod === "object" && "default" in (mod as any)) {
        return (mod as any).default as typeof WebSocket;
      }
      return mod as typeof WebSocket;
    } catch {}
  }
  throw new Error(
    "No WebSocket implementation available (tried global and 'ws'). Install 'ws' or supply WebSocketImpl."
  );
}

// Generic protobuf message helpers (ts-proto style fns). Expect fns to have encode/decode(BinaryWriter/BinaryReader)
// Generic encode/decode helpers for ts-proto style message fns.
// Assumes fns.encode supplies a default writer when writer param omitted.
export interface TsProtoEncoder<T> {
  encode(message: T, writer?: unknown): { finish(): Uint8Array };
}
export interface TsProtoDecoder<T> {
  decode(input: Uint8Array, length?: number): T;
}
export function encodeMessage<T>(msg: T, fns: TsProtoEncoder<T>): Uint8Array {
  const w = fns.encode(msg);
  return w.finish();
}
export function decodeMessage<T>(bytes: Uint8Array, fns: TsProtoDecoder<T>): T {
  return fns.decode(bytes);
}
