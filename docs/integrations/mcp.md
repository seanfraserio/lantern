# Model Context Protocol (MCP)

Trace all `callTool()` invocations on an MCP client. The wrapper intercepts tool calls and records them as `tool_call` spans with input arguments, results, and error status.

## Installation

```bash
npm install @openlantern-ai/sdk @modelcontextprotocol/sdk
```

No additional integration package is needed — the MCP collector is included in `@openlantern-ai/sdk`.

## Setup

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { LanternTracer, wrapMcpClient } from "@openlantern-ai/sdk";

const tracer = new LanternTracer({
  apiKey: process.env.LANTERN_API_KEY,
  baseUrl: process.env.LANTERN_BASE_URL,
});

const mcpClient = new Client({
  name: "my-app",
  version: "1.0.0",
});

// Connect to an MCP server
await mcpClient.connect(transport);

// Wrap the client — all callTool() calls are now traced
const tracedClient = wrapMcpClient(mcpClient, tracer, {
  agentName: "my-mcp-agent", // optional, defaults to "mcp-agent"
});
```

## Usage

### Basic tool call

```typescript
const result = await tracedClient.callTool({
  name: "read_file",
  arguments: { path: "/etc/hostname" },
});

console.log(result.content);
// A tool_call span is automatically created and closed
```

### Use with an existing trace

```typescript
const tracedClient = wrapMcpClient(mcpClient, tracer, {
  traceId: existingTraceId,
  agentName: "sub-agent",
});
```

When a `traceId` is provided, tool call spans are attached to that trace instead of creating a new one per call.

### Multiple tool calls in sequence

```typescript
// Each call creates its own trace (unless traceId is provided)
await tracedClient.callTool({ name: "list_files", arguments: { dir: "/tmp" } });
await tracedClient.callTool({ name: "read_file", arguments: { path: "/tmp/data.json" } });
```

## What Gets Traced

| MCP Operation | Lantern Span Type | Captured Data |
|---------------|-------------------|---------------|
| `callTool()` | `tool_call` | Tool name, input arguments, text content from result |
| Tool errors (thrown) | `tool_call` (with error) | Error message |
| Tool errors (returned `isError: true`) | `tool_call` (with error) | Error content from result |

### How it works

The wrapper replaces `callTool` on the client object with a function that:
1. Creates a `tool_call` span with the tool name and arguments
2. Calls the original `callTool`
3. Extracts text content from the MCP result's `content` array
4. Ends the span with the content (or error status if `isError` is true or an exception is thrown)

The wrapper mutates the client in place and returns it, so `tracedClient === mcpClient` after wrapping.

### Scope

Only `callTool()` is traced. Other MCP operations like `listTools()`, `listResources()`, or `readResource()` are not intercepted.

## Troubleshooting

**Spans not appearing**
- Verify the client is wrapped *after* calling `connect()` — the wrapper binds to the current `callTool` method.
- Check that `LANTERN_API_KEY` and `LANTERN_BASE_URL` are set correctly.

**Each tool call creates a separate trace**
- This is the default behavior when no `traceId` is provided. Pass a `traceId` to group multiple tool calls under one trace.

**Error spans for successful calls**
- If the MCP server returns `isError: true` in the result, the span is marked as an error even though no exception was thrown. Check your MCP server implementation.

## API Reference

```typescript
function wrapMcpClient<T extends McpClient>(
  client: T,
  tracer: LanternTracer,
  opts?: {
    traceId?: string;
    agentName?: string;
  }
): T;
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `client` | `McpClient` | An MCP client instance (must have a `callTool` method) |
| `tracer` | `LanternTracer` | A configured Lantern tracer instance |
| `opts.traceId` | `string` | Optional — attach spans to an existing trace |
| `opts.agentName` | `string` | Optional — name shown in dashboard (default: `"mcp-agent"`) |
