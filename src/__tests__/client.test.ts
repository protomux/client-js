// Integration tests for ProtomuxClient
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ProtomuxClient, ProtomuxError } from '../index.js';
import {
  MockProtomuxServer,
  createMockCodec,
  waitFor,
  sleep,
} from './utils.js';
import { WebSocket } from 'ws';

describe('ProtomuxClient', () => {
  let server: MockProtomuxServer;
  let client: ProtomuxClient;

  beforeEach(() => {
    server = new MockProtomuxServer();
  });

  afterEach(async () => {
    if (client && client.readyState !== WebSocket.CLOSED && client.readyState !== WebSocket.CLOSING) {
      client.close();
    }
    if (server) {
      await server.close();
    }
  });

  describe('Connection Lifecycle', () => {
    it('should connect to server successfully', async () => {
      client = new ProtomuxClient(server.url, {
        WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
      });

      await server.waitForConnection();
      // Wait for client to be fully connected
      await waitFor(() => client.readyState === WebSocket.OPEN);
      expect(client.readyState).toBe(WebSocket.OPEN);
    });

    it('should call onOpen callback when connected', async () => {
      let opened = false;
      client = new ProtomuxClient(server.url, {
        WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
        onOpen: () => {
          opened = true;
        },
      });

      await server.waitForConnection();
      await waitFor(() => opened);
      expect(opened).toBe(true);
    });

    it('should call onClose callback when connection closes', async () => {
      let closeInfo: { code: number; reason: string; wasClean: boolean } | undefined;
      client = new ProtomuxClient(server.url, {
        WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
        onClose: (info) => {
          closeInfo = info;
        },
      });

      const ws = await server.waitForConnection();
      ws.close(1000, 'normal closure');

      await waitFor(() => closeInfo !== undefined);
      expect(closeInfo?.code).toBe(1000);
      expect(closeInfo?.reason).toBe('normal closure');
      expect(closeInfo?.wasClean).toBe(true);
    });

    it('should support onOpen handler registration', async () => {
      client = new ProtomuxClient(server.url, {
        WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
      });

      let handlerCalled = false;
      const unsubscribe = client.onOpen(() => {
        handlerCalled = true;
      });

      await server.waitForConnection();
      await waitFor(() => handlerCalled);
      expect(handlerCalled).toBe(true);

      // Test unsubscribe
      unsubscribe();
    });

    it('should support onClose handler registration', async () => {
      client = new ProtomuxClient(server.url, {
        WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
      });

      let handlerCalled = false;
      const unsubscribe = client.onClose(() => {
        handlerCalled = true;
      });

      const ws = await server.waitForConnection();
      ws.close();

      await waitFor(() => handlerCalled);
      expect(handlerCalled).toBe(true);

      // Test unsubscribe
      unsubscribe();
    });

    it('should timeout if server does not respond', async () => {
      const nonExistentUrl = 'ws://localhost:9999';
      client = new ProtomuxClient(nonExistentUrl, {
        WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
        openTimeoutMs: 100,
      });

      await expect(client.sendRaw('test', new Uint8Array())).rejects.toThrow();
    });
  });

  describe('Request/Response RPC', () => {
    beforeEach(async () => {
      client = new ProtomuxClient(server.url, {
        WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
      });
      await server.waitForConnection();
    });

    it('should send and receive raw request/response', async () => {
      server.on('test.Request', (ws, env) => {
        const response = new TextEncoder().encode('response');
        server.reply(ws, env.cid, 'test.Response', response);
      });

      const request = new TextEncoder().encode('request');
      const response = await client.sendRaw('test.Request', request);
      const responseText = new TextDecoder().decode(response);

      expect(responseText).toBe('response');
    });

    it('should send and receive typed request/response', async () => {
      const codec = createMockCodec<{ message: string }>();

      server.on('test.TypedRequest', (ws, env) => {
        const req = codec.decode(env.payload);
        const res = { message: `echo: ${req.message}` };
        server.reply(ws, env.cid, 'test.TypedResponse', codec.encode(res).finish());
      });

      const response = await client.send(
        'test.TypedRequest',
        { message: 'hello' },
        codec,
        codec
      );

      expect(response.message).toBe('echo: hello');
    });

    it('should handle multiple concurrent requests', async () => {
      server.on('test.Concurrent', (ws, env) => {
        const req = new TextDecoder().decode(env.payload);
        const res = new TextEncoder().encode(`reply:${req}`);
        // Add small delay to test concurrency
        setTimeout(() => {
          server.reply(ws, env.cid, 'test.Response', res);
        }, 10);
      });

      const promises = Array.from({ length: 5 }, (_, i) =>
        client.sendRaw('test.Concurrent', new TextEncoder().encode(`msg${i}`))
      );

      const responses = await Promise.all(promises);
      expect(responses.length).toBe(5);
      
      const texts = responses.map((r) => new TextDecoder().decode(r));
      expect(texts).toContain('reply:msg0');
      expect(texts).toContain('reply:msg4');
    });

    it('should timeout if server does not respond', async () => {
      server.on('test.Slow', () => {
        // Don't send response
      });

      await expect(
        client.sendRaw('test.Slow', new Uint8Array(), { timeoutMs: 100 })
      ).rejects.toThrow('request timeout');
    });

    it('should support custom timeout per request', async () => {
      server.on('test.CustomTimeout', (ws, env) => {
        setTimeout(() => {
          server.reply(ws, env.cid, 'test.Response', new Uint8Array());
        }, 200);
      });

      // Should timeout with default
      await expect(
        client.sendRaw('test.CustomTimeout', new Uint8Array(), { timeoutMs: 100 })
      ).rejects.toThrow('request timeout');

      // Should succeed with longer timeout
      await expect(
        client.sendRaw('test.CustomTimeout', new Uint8Array(), { timeoutMs: 500 })
      ).resolves.toBeDefined();
    });
  });

  describe('Fire and Forget', () => {
    beforeEach(async () => {
      client = new ProtomuxClient(server.url, {
        WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
      });
      await server.waitForConnection();
    });

    it('should send fire-and-forget message', async () => {
      let received = false;
      server.on('test.FireAndForget', () => {
        received = true;
      });

      await client.sendFireAndForget('test.FireAndForget', new Uint8Array([1, 2, 3]));
      await waitFor(() => received);
      expect(received).toBe(true);
    });
  });

  describe('Push Messages', () => {
    beforeEach(async () => {
      client = new ProtomuxClient(server.url, {
        WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
      });
      await server.waitForConnection();
    });

    it('should receive push messages', async () => {
      let pushReceived = false;
      client.onPush(() => {
        pushReceived = true;
      });

      const payload = new TextEncoder().encode('push data');
      server.push('test.PushEvent', payload);

      await waitFor(() => pushReceived);
      expect(pushReceived).toBe(true);
    });

    it('should handle typed push messages with onMessage', async () => {
      const codec = createMockCodec<{ value: number }>();
      let receivedValue: number | null = null;

      client.onMessage('test.TypedPush', codec, (msg) => {
        receivedValue = msg.value;
      });

      const payload = codec.encode({ value: 42 }).finish();
      server.push('test.TypedPush', payload);

      await waitFor(() => receivedValue !== null);
      expect(receivedValue).toBe(42);
    });

    it('should handle multiple push handlers for same type', async () => {
      let handler1Called = false;
      let handler2Called = false;

      client.on('test.MultiPush', () => {
        handler1Called = true;
      });

      client.on('test.MultiPush', () => {
        handler2Called = true;
      });

      server.push('test.MultiPush', new Uint8Array());

      await waitFor(() => handler1Called && handler2Called);
      expect(handler1Called).toBe(true);
      expect(handler2Called).toBe(true);
    });

    it('should support unsubscribe from push handlers', async () => {
      let callCount = 0;
      const unsubscribe = client.on('test.Unsubscribe', () => {
        callCount++;
      });

      server.push('test.Unsubscribe', new Uint8Array());
      await waitFor(() => callCount === 1);

      unsubscribe();
      server.push('test.Unsubscribe', new Uint8Array());
      await sleep(50);

      expect(callCount).toBe(1);
    });
  });

  describe('Pub/Sub', () => {
    beforeEach(async () => {
      client = new ProtomuxClient(server.url, {
        WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
      });
      await server.waitForConnection();
    });

    it('should send subscribe message', async () => {
      let subscribed = false;
      server.on('protomux.subscribe', (ws, env) => {
        const topic = new TextDecoder().decode(env.payload);
        expect(topic).toBe('test:topic');
        subscribed = true;
      });

      await client.subscribe('test:topic');
      await waitFor(() => subscribed);
      expect(subscribed).toBe(true);
    });

    it('should send unsubscribe message', async () => {
      let unsubscribed = false;
      server.on('protomux.unsubscribe', (ws, env) => {
        const topic = new TextDecoder().decode(env.payload);
        expect(topic).toBe('test:topic');
        unsubscribed = true;
      });

      const unsub = await client.subscribe('test:topic');
      await unsub();
      
      await waitFor(() => unsubscribed);
      expect(unsubscribed).toBe(true);
    });
  });

  describe('Error Handling', () => {
    beforeEach(async () => {
      client = new ProtomuxClient(server.url, {
        WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
      });
      await server.waitForConnection();
    });

    it('should handle error responses', async () => {
      server.on('test.ErrorRequest', (ws, env) => {
        server.replyError(ws, env.cid, 404, 'Not found');
      });

      await expect(client.sendRaw('test.ErrorRequest', new Uint8Array())).rejects.toThrow(
        ProtomuxError
      );

      try {
        await client.sendRaw('test.ErrorRequest', new Uint8Array());
      } catch (err) {
        expect(err).toBeInstanceOf(ProtomuxError);
        const protomuxErr = err as ProtomuxError;
        expect(protomuxErr.code).toBe(404);
        expect(protomuxErr.message).toBe('Not found');
        expect(protomuxErr.details).toEqual([]);
      }
    });

    it('should handle error responses with details', async () => {
      server.on('test.ErrorWithDetails', (ws, env) => {
        const details = [
          { type: 'validation.Field', data: new TextEncoder().encode('field1') },
          { type: 'validation.Field', data: new TextEncoder().encode('field2') },
        ];
        server.replyError(ws, env.cid, 400, 'Validation failed', details);
      });

      try {
        await client.sendRaw('test.ErrorWithDetails', new Uint8Array());
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ProtomuxError);
        const protomuxErr = err as ProtomuxError;
        expect(protomuxErr.code).toBe(400);
        expect(protomuxErr.message).toBe('Validation failed');
        expect(protomuxErr.details.length).toBe(2);
        expect(protomuxErr.details[0].type).toBe('validation.Field');
        expect(new TextDecoder().decode(protomuxErr.details[0].data)).toBe('field1');
      }
    });

    it('should reject pending requests on connection close', async () => {
      server.on('test.NeverRespond', () => {
        // Don't respond
      });

      const promise = client.sendRaw('test.NeverRespond', new Uint8Array());
      
      // Close connection while request is pending
      const ws = [...server.clients][0];
      ws.close();

      await expect(promise).rejects.toThrow('connection closed');
    });
  });

  describe('Cancellation', () => {
    beforeEach(async () => {
      client = new ProtomuxClient(server.url, {
        WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
      });
      await server.waitForConnection();
    });

    it('should support AbortSignal cancellation', async () => {
      server.on('test.Cancelable', () => {
        // Don't respond immediately
      });

      const controller = new AbortController();
      const promise = client.sendRaw('test.Cancelable', new Uint8Array(), {
        signal: controller.signal,
      });

      // Cancel after a short delay
      setTimeout(() => controller.abort(), 50);

      await expect(promise).rejects.toThrow('aborted');
    });

    it('should reject immediately if signal already aborted', async () => {
      const controller = new AbortController();
      controller.abort();

      await expect(
        client.sendRaw('test.Any', new Uint8Array(), { signal: controller.signal })
      ).rejects.toThrow('aborted');
    });

    it('should send cancel frame when aborted', async () => {
      let cancelReceived = false;
      server.on('test.CancelFrame', (ws, env) => {
        // Check if this is a cancel frame (FlagCancel = 0x20)
        if (env.flags & 0x20) {
          cancelReceived = true;
        }
      });

      const controller = new AbortController();
      const promise = client.sendRaw('test.CancelFrame', new Uint8Array(), {
        signal: controller.signal,
        timeoutMs: 5000,
      });

      await sleep(50);
      controller.abort();

      await expect(promise).rejects.toThrow('aborted');
      await waitFor(() => cancelReceived, 500);
      expect(cancelReceived).toBe(true);
    });
  });

  describe('Deadlines', () => {
    beforeEach(async () => {
      client = new ProtomuxClient(server.url, {
        WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
      });
      await server.waitForConnection();
    });

    it('should send deadline in request', async () => {
      let receivedDeadline = false;
      server.on('test.WithDeadline', (ws, env) => {
        // Check if deadline flag is set (FlagDeadline = 0x40)
        if (env.flags & 0x40) {
          receivedDeadline = true;
          // Reply immediately
          server.reply(ws, env.cid, 'test.Response', new Uint8Array());
        }
      });

      await client.sendRaw('test.WithDeadline', new Uint8Array(), { deadlineMs: 1000 });
      expect(receivedDeadline).toBe(true);
    });
  });
});
