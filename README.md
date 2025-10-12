# @protomux/client (JS/TS)

WebSocket client for the [Protomux](../protomux/README.md) binary envelope protocol.

## Features
- Tiny (~no deps) core: encode / decode envelope, correlating unary requests
- Push frames (cid=0) dispatch + per-type listeners
- Topic subscribe/unsubscribe helpers
- Works in browser & Node (auto-detects / falls back to `ws`)
- Full ts-proto integration with typed `send()` and `onMessage()` helpers
- Structured error handling with `ProtomuxError` (code, message, details)
- Deadline support and AbortSignal cancellation
- Custom HTTP headers for WebSocket upgrade (Node environments)

## Install
From an example app (Node / bundler):
```bash
npm install @protomux/client
```
If using locally via workspace / file reference, ensure build step copies sources or use a monorepo.

## Quick Start
```ts
import { ProtomuxClient } from '@protomux/client';
import { ListBooksRequest, ListBooksResponse } from './gen/proto/book_service';

const client = new ProtomuxClient('ws://localhost:3000/ws');

async function listBooks() {
	const resp = await client.send(
		'examples.book.ListBooksRequest',
		{},
		ListBooksRequest,
		ListBooksResponse
	);
	console.log(resp.books);
}

// Listen for push events
client.onMessage('examples.book.BookCreatedEvent', BookCreatedEvent, (event) => {
	console.log('New book:', event.book);
});

listBooks();
```

## API

### `new ProtomuxClient(url, options?)`
Options:
- `timeoutMs` (default 5000): per unary request timeout
- `openTimeoutMs` (default 3000): initial socket open wait
- `protocol` (default `protomux.v1`): WebSocket subprotocol
- `WebSocketImpl`: custom WS class (supply in tests or exotic envs)
- `headers`: (Node) HTTP headers for upgrade (e.g. `Authorization: Bearer <token>`)
- `onOpen`: callback when socket opens
- `onClose`: callback when socket closes with `{code, reason, wasClean}`
- `onError`: global error hook for push-level or unhandled errors

### Core Methods

#### `send<TReq, TRes>(typeName, req, reqCodec, resCodec, opts?): Promise<TRes>`
Typed RPC call with protobuf codecs (ts-proto style).
```ts
const resp = await client.send(
	'examples.book.ListBooksRequest',
	{},
	ListBooksRequest,
	ListBooksResponse
);
```
Options: `timeoutMs`, `deadlineMs`, `signal` (AbortSignal)

#### `sendRaw(typeName, payload: Uint8Array, opts?): Promise<Uint8Array>`
Raw request/response without protobuf encoding.

#### `sendFireAndForget(typeName, payload: Uint8Array): Promise<void>`
Fire-and-forget message (no response expected).

### Event Handling

#### `onMessage<T>(typeName, decoder, handler): () => void`
Register a typed message handler with auto-decode.
```ts
client.onMessage('examples.chat.MessageEvent', ChatMessageEvent, (msg) => {
	console.log('Message:', msg);
});
```
Returns unsubscribe function.

#### `on(typeName, fn): () => void`
Register handler for specific push type (raw bytes).

#### `onPush(fn)`
All push envelopes (cid=0) delivered to fn.

### Lifecycle Hooks

#### `onOpen(handler): () => void`
Register handler for WebSocket open event.

#### `onClose(handler): () => void`
Register handler for WebSocket close event with `{code, reason, wasClean}`.

#### `onError(handler): () => void`
Register handler for WebSocket error event.

### Topic Subscriptions

#### `subscribe(topic): Promise<() => void>`
Subscribes to a server topic (sends `protomux.subscribe`). Returns an unsubscribe function that sends `protomux.unsubscribe`.
```ts
const unsub = await client.subscribe('chat:room:general');
// later: await unsub();
```

### Connection State

#### `readyState: number`
Returns WebSocket ready state (0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED).

#### `close()`
Close the WebSocket connection.

## Error Handling

### Per-request try/catch
```ts
try {
	await client.send(
		'examples.chat.SendMessageRequest',
		{ room: "general", user: "alice", text: "hi" },
		SendMessageRequest,
		SendMessageResponse
	);
} catch (err) {
	if (err instanceof ProtomuxError) {
		console.warn('server error code', err.code, 'message', err.message);
		for (const d of err.details) {
			console.log(' detail type:', d.type, 'bytes len:', d.data.length);
		}
	} else {
		console.error('transport/local error', err);
	}
}
```

### Error object
Server replies flagged as error (FlagError or type name `error`) are decoded into `ProtomuxError`:
```ts
class ProtomuxError extends Error {
	constructor(public code: number, message: string, public details: { type: string; data: Uint8Array }[]) { super(message); }
}
```
`code` mirrors server numeric `Code` (see server docs) and `details` is an array of typed binary attachments (optional).

### Global error hook (push-level)
You can receive unsolicited error frames (cid=0) via `onError` option:
```ts
const client = new ProtomuxClient('ws://localhost:3000/ws', {
	onError: (err, env) => {
		console.log('push error', err.code, err.message, 'original type', env.typeName);
	},
});
```

### Deadlines & cancellation
Use `send()` or `sendRaw()` with `deadlineMs` or an `AbortSignal`.
```ts
// Deadline (relative timeout sent to server). Server cancels handler context if exceeded.
await client.send(
	'examples.long.OpRequest',
	{},
	LongOpRequest,
	LongOpResponse,
	{ deadlineMs: 750 }
);

// Client-side cancellation
const controller = new AbortController();
const p = client.send(
	'examples.chat.SendMessageRequest',
	{ room: 'general', user: 'alice', text: 'hi' },
	SendMessageRequest,
	SendMessageResponse,
	{ signal: controller.signal }
);
controller.abort(); // sends cancel frame; promise rejects with Error('aborted')
```

### Distinguishing failure modes
| Failure | Error instance | Notes |
|---------|----------------|-------|
| Server returned application error | `ProtomuxError` | Inspect `.code` / `.details` |
| Deadline exceeded client-side (timeoutMs) | `Error('request timeout')` | Local timer fired |
| Aborted via AbortSignal | `Error('aborted')` | Cancel frame sent to server |
| Connection closed mid-flight | `Error('connection closed')` | All pending rejected |

### Decoding typed details (example)
If server sent a detail with type `my.company.validation` containing a protobuf ValidationError:
```ts
for (const d of err.details) {
	if (d.type === 'my.company.validation') {
		const ve = ValidationError.decode(d.data);
		console.log('validation issues', ve.fields);
	}
}
```

### Malformed frames
Frames failing to decode are ignored (defensive) so a single bad push doesn’t tear down the connection.

### Best practices
* Prefer deadlines for operations where the server can abandon work early.
* Use AbortController to tie a request to React component lifecycle or user navigation.
* Centralize logging in `onError` and rethrow / surface as needed.
* Normalize `ProtomuxError.code` to UI-friendly messages in a small mapping.

## Auth (JWT Example)
Pass headers in Node (requires `ws` package):
```ts
import WebSocket from 'ws';

const client = new ProtomuxClient('ws://localhost:3000/ws', {
	WebSocketImpl: WebSocket as any,
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

## Examples

The repository includes several complete examples demonstrating different use cases:

- **[Basic Service](../examples/basic/README.md)** - Simple Book CRUD with request/response RPC
- **[Chat Application](../examples/chat/README.md)** - Real-time chat with pub/sub and push events
- **[JWT Authentication](../examples/jwt/README.md)** - Secure WebSocket with JWT tokens
- **[Thundering Herd Protection](../examples/thunderingherd/README.md)** - Connection admission control

See the [examples README](../examples/README.md) for complete documentation and setup instructions.

## Development

### Build
```bash
npm run build
```

### Tests
The library includes comprehensive test coverage using Vitest:

```bash
# Run all tests once
npm test

# Run tests in watch mode
npm run test:watch

# Generate coverage report
npm run test:coverage
```

## License
MIT (adjust if needed).

