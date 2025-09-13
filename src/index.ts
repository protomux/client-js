// Protomux JS Client Library
// Public API: ProtomuxClient, encodeEnvelope, decodeEnvelope

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

export type Pending = {
  resolve: (v: Uint8Array) => void;
  reject: (e: any) => void;
};

export interface ProtomuxClientOptions {
  timeoutMs?: number;
  protocol?: string;
  WebSocketImpl?: any;
}

export class ProtomuxClient {
  private ws: WebSocket;
  private pending = new Map<number, Pending>();
  private openPromise: Promise<void>;
  private timeoutMs: number;

  constructor(private url: string, opts: ProtomuxClientOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? 5000;
    const proto = opts.protocol ?? "protomux.v1";
    const WSImpl: any = resolveWS(opts);
    this.ws = new WSImpl(url, proto);
    (this.ws as any).binaryType = "arraybuffer";
    this.ws.onmessage = (ev: any) => this.onMessage(ev.data as ArrayBuffer);
    this.ws.onopen = () => {
      /* optional hook */
    };
    this.ws.onerror = (e: any) => {
      /* swallow; surfaced via pending timeouts */
    };
    this.ws.onclose = () => {
      // reject all pending
      for (const [cid, p] of this.pending.entries()) {
        p.reject(new Error("connection closed"));
      }
      this.pending.clear();
    };
    this.openPromise = new Promise((res) => {
      this.ws.addEventListener("open", () => res(), { once: true });
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
        // push frame: ignore for now
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

  get readyState() {
    return (this.ws as any).readyState;
  }
  close() {
    this.ws.close();
  }
}

// Correlation id generator
let nextCID = 1;
function allocCID() {
  return nextCID++;
}

function resolveWS(opts: ProtomuxClientOptions): any {
  if (opts.WebSocketImpl) return opts.WebSocketImpl;
  if ((globalThis as any).WebSocket) return (globalThis as any).WebSocket;
  throw new Error(
    "No WebSocket implementation available. Pass WebSocketImpl option in Node."
  );
}

// Generic protobuf message helpers (ts-proto style fns). Expect fns to have encode/decode(BinaryWriter/BinaryReader)
// Generic encode/decode helpers for ts-proto style message fns.
// Assumes fns.encode supplies a default writer when writer param omitted.
export function encodeMessage<T>(msg: T, fns: { encode(message: T, writer?: any): any }): Uint8Array {
  const w = fns.encode(msg as any); // rely on default BinaryWriter inside generated code
  return w.finish();
}

export function decodeMessage<T>(bytes: Uint8Array, fns: { decode(input: any, length?: number): T }): T {
  // ts-proto decode accepts Uint8Array directly
  return fns.decode(bytes);
}
