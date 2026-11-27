# @0xpixelninja/conveno-protocol

Conveno wire protocol: zod schemas, inferred TypeScript types, NDJSON framing and IPC helpers.
The human-readable spec is [PROTOCOL.md](./PROTOCOL.md); it is the contract any other
implementation (for example a Rust relay) must follow. Runtime-agnostic: no Node-only imports.
