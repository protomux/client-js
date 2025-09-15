# @protomux/client (JS/TS)

Lightweight WebSocket client for the Protomux binary envelope protocol.

## Features
- Tiny (~no deps) core: encode / decode envelope, correlating unary requests
- Promise based `request` with timeout
- Push frames (cid=0) dispatch + per-type listeners
- Topic subscribe/unsubscribe helpers
- Works in browser & Node (auto-detects / falls back to `ws`)
- Helpers for ts-proto generated message encode/decode

## Install
From an example app (Node / bundler):
```bash
npm install @protomux/client
```
If using locally via workspace / file reference, ensure build step copies sources or use a monorepo.

## Envelope Recap
```
byte 0   : version (1)
byte 1   : flags
varint   : correlation id (0 => push)
varint   : type name length (N)
N bytes  : UTF-8 type name
varint   : payload length (M)
M bytes  : payload (raw protobuf bytes)
```

## Quick Start
```ts
import { ProtomuxClient, encodeMessage, decodeMessage } from '@protomux/client';
import { ListBooksRequest, ListBooksResponse } from './gen/proto/book_service';

const client = new ProtomuxClient('ws://localhost:3000/ws');

async function listBooks() {
	const reqBytes = encodeMessage({}, ListBooksRequest);
	const resBytes = await client.request('examples.book.ListBooksRequest', reqBytes);
	const resp = decodeMessage(resBytes, ListBooksResponse);
	console.log(resp.books);
}

client.on('examples.book.MessageEvent', (bytes) => {
	// decode event type if you have descriptor fns
});

listBooks();
```

## API
### `new ProtomuxClient(url, options?)`
Options:
- `timeoutMs` (default 5000): per unary request timeout
- `openTimeoutMs` (default 3000): initial socket open wait
- `protocol` (default `protomux.v1`)
- `WebSocketImpl`: custom WS class (supply in tests or exotic envs)
- `headers`: (Node) HTTP headers for upgrade (e.g. Authorization: Bearer <token>)
- `onOpen`: callback when socket opens

### `request(typeName, payload: Uint8Array): Promise<Uint8Array>`
Sends unary request returning response bytes.

### `rawSend(typeName, payload)` / `send(typeName, payload)`
Fire-and-forget (correlation id allocated but server may ignore response path if not expecting).

### `onPush(fn)`
All push envelopes (cid=0) delivered to fn.

### `on(typeName, fn)`
Register handler for specific push type; returns unsubscribe function.

### `subscribe(topic): Promise<() => void>`
Subscribes to a server topic (sends `protomux.subscribe`). Returns an unsubscribe function that sends `protomux.unsubscribe`.

### Proto Helpers
`encodeMessage(msg, MessageFns)` and `decodeMessage(bytes, MessageFns)` interoperate with ts-proto style exported objects.

## Error Handling
- Timeouts produce `Error("request timeout")`.
- Closed connection rejects all pending requests with `connection closed`.
- Malformed frames ignored silently (defensive for shared channels).

## Auth (JWT Example)
Pass headers in Node:
```ts
const client = new ProtomuxClient('ws://localhost:3000/ws', {
	headers: { Authorization: `Bearer ${process.env.JWT_TOKEN}` }
});
```

## Browser Usage
Works out of the box. If bundler targets ESM, ensure no Node polyfills required (package has no hard Node deps).

## Reconnection Strategy
Currently not built-in. Wrap construction in your own backoff loop for resilience:
```ts
async function connectWithRetry() { /* implement expo backoff, recreate client */ }
```

## Type Names
Must match fully-qualified proto message names the server registered (`proto.MessageName`). Example: `examples.book.ListBooksRequest`.

## Development
Run build (if you add tsconfig + build tooling):
```bash
npm run build
```
Tests (not yet included) could mock WebSocket via a local pair or `ws` server.

## License
MIT (adjust if needed).

