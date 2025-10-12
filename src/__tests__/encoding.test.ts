// Unit tests for varint and envelope encoding/decoding
import { describe, it, expect } from 'vitest';
import { encodeVarint, decodeVarint, encodeEnvelope, decodeEnvelope } from './utils.js';

describe('Varint Encoding/Decoding', () => {
  it('should encode and decode small integers', () => {
    const values = [0, 1, 127, 128, 255, 256];
    for (const val of values) {
      const encoded = encodeVarint(val);
      const view = new DataView(encoded.buffer);
      const [decoded, offset] = decodeVarint(view, 0);
      expect(decoded).toBe(val);
      expect(offset).toBe(encoded.length);
    }
  });

  it('should encode and decode large integers', () => {
    const values = [16383, 16384, 2097151, 2097152, 268435455, 268435456];
    for (const val of values) {
      const encoded = encodeVarint(val);
      const view = new DataView(encoded.buffer);
      const [decoded, offset] = decodeVarint(view, 0);
      expect(decoded).toBe(val);
      expect(offset).toBe(encoded.length);
    }
  });

  it('should encode 0 as single byte', () => {
    const encoded = encodeVarint(0);
    expect(encoded.length).toBe(1);
    expect(encoded[0]).toBe(0);
  });

  it('should encode 127 as single byte', () => {
    const encoded = encodeVarint(127);
    expect(encoded.length).toBe(1);
    expect(encoded[0]).toBe(127);
  });

  it('should encode 128 as two bytes', () => {
    const encoded = encodeVarint(128);
    expect(encoded.length).toBe(2);
    expect(encoded[0]).toBe(0x80); // 128 with continuation bit
    expect(encoded[1]).toBe(0x01); // remaining value
  });

  it('should throw on varint overflow', () => {
    const emptyBuffer = new Uint8Array(0);
    const view = new DataView(emptyBuffer.buffer);
    expect(() => decodeVarint(view, 0)).toThrow('varint overflow');
  });
});

describe('Envelope Encoding/Decoding', () => {
  it('should encode and decode basic envelope', () => {
    const typeName = 'test.Message';
    const payload = new TextEncoder().encode('hello');
    const cid = 42;
    const flags = 0;

    const encoded = encodeEnvelope(cid, typeName, payload, flags);
    const decoded = decodeEnvelope(encoded.buffer as ArrayBuffer);

    expect(decoded.version).toBe(1);
    expect(decoded.flags).toBe(flags);
    expect(decoded.cid).toBe(cid);
    expect(decoded.typeName).toBe(typeName);
    expect(decoded.payload).toEqual(payload);
  });

  it('should encode and decode envelope with flags', () => {
    const typeName = 'test.ErrorMessage';
    const payload = new Uint8Array([1, 2, 3, 4]);
    const cid = 100;
    const flags = 0x02; // FlagError

    const encoded = encodeEnvelope(cid, typeName, payload, flags);
    const decoded = decodeEnvelope(encoded.buffer as ArrayBuffer);

    expect(decoded.version).toBe(1);
    expect(decoded.flags).toBe(flags);
    expect(decoded.cid).toBe(cid);
    expect(decoded.typeName).toBe(typeName);
    expect(decoded.payload).toEqual(payload);
  });

  it('should encode and decode push message (cid=0)', () => {
    const typeName = 'push.Event';
    const payload = new Uint8Array([10, 20, 30]);
    const cid = 0;

    const encoded = encodeEnvelope(cid, typeName, payload);
    const decoded = decodeEnvelope(encoded.buffer as ArrayBuffer);

    expect(decoded.cid).toBe(0);
    expect(decoded.typeName).toBe(typeName);
    expect(decoded.payload).toEqual(payload);
  });

  it('should encode and decode empty payload', () => {
    const typeName = 'test.Empty';
    const payload = new Uint8Array(0);
    const cid = 1;

    const encoded = encodeEnvelope(cid, typeName, payload);
    const decoded = decodeEnvelope(encoded.buffer as ArrayBuffer);

    expect(decoded.cid).toBe(cid);
    expect(decoded.typeName).toBe(typeName);
    expect(decoded.payload.length).toBe(0);
  });

  it('should encode and decode long type names', () => {
    const typeName = 'com.example.very.long.package.name.MessageType';
    const payload = new Uint8Array([42]);
    const cid = 5;

    const encoded = encodeEnvelope(cid, typeName, payload);
    const decoded = decodeEnvelope(encoded.buffer as ArrayBuffer);

    expect(decoded.typeName).toBe(typeName);
    expect(decoded.cid).toBe(cid);
  });

  it('should encode and decode large payloads', () => {
    const typeName = 'test.LargeMessage';
    const payload = new Uint8Array(10000).fill(123);
    const cid = 999;

    const encoded = encodeEnvelope(cid, typeName, payload);
    const decoded = decodeEnvelope(encoded.buffer as ArrayBuffer);

    expect(decoded.typeName).toBe(typeName);
    expect(decoded.cid).toBe(cid);
    expect(decoded.payload.length).toBe(10000);
    expect(decoded.payload[0]).toBe(123);
    expect(decoded.payload[9999]).toBe(123);
  });

  it('should properly mask flags to single byte', () => {
    const typeName = 'test.Message';
    const payload = new Uint8Array([1]);
    const cid = 1;
    const flags = 0x1ff; // More than 8 bits

    const encoded = encodeEnvelope(cid, typeName, payload, flags);
    const decoded = decodeEnvelope(encoded.buffer as ArrayBuffer);

    expect(decoded.flags).toBe(0xff); // Should be masked to 8 bits
  });
});
