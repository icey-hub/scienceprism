import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { prepareMcpStdio, confirmMcpStopped } from './isolation.js';
import { HarnessRuntimeError } from '../harnessRuntime/errors.js';

/** SDK lifecycle is retained; policy checks precede the actual spawn/send/fetch.
 * Closing an SDK handle alone is not proof that its process has stopped. */
export async function createMcpTransport({ projectRoot, home, server, signal, beforeRequest, onProcess, capabilityPolicy, copyProject = false }) {
  if (server.transport === 'stdio') {
    const command = await prepareMcpStdio({ projectRoot, home, server, signal, capabilityPolicy, copyProject });
    class ProtectedStdioTransport extends StdioClientTransport {
      ownedPid = null;
      stopping = null;
      async start() {
        await beforeRequest?.();
        signal?.throwIfAborted();
        // A crash after spawn must retain an unknown owner, never a false stop.
        await onProcess?.({ pid: null, stopConfirmed: false, isolation: command.isolation });
        await beforeRequest?.();
        signal?.throwIfAborted();
        const started = super.start();
        this.ownedPid = this.pid;
        // Prevent an unhandled spawn error while persisting ownership.
        started.catch(() => {});
        if (this.ownedPid) await onProcess?.({ pid: this.ownedPid, stopConfirmed: false, isolation: command.isolation });
        await started;
        signal?.throwIfAborted();
      }
      async send(message) {
        await beforeRequest?.();
        signal?.throwIfAborted();
        return super.send(message);
      }
      async close() {
        if (!this.stopping) this.stopping = (async () => {
          await super.close();
          await confirmMcpStopped(this.ownedPid);
          await onProcess?.({ pid: this.ownedPid, stopConfirmed: true, isolation: command.isolation });
        })();
        return this.stopping;
      }
    }
    const transport = new ProtectedStdioTransport({ ...command, stderr: 'pipe', maxBufferSize: 1_000_000 });
    let stderrBytes = 0;
    transport.stderr.on('data', chunk => {
      stderrBytes += chunk.length;
      if (stderrBytes > 1_000_000) void transport.close().catch(() => {});
    });
    return { transport, isolation: command.isolation };
  }
  const endpoint = new URL(server.url).href;
  const guardedFetch = async (url, options = {}) => {
    const current = new URL(String(url));
    if (current.href !== endpoint) throw new HarnessRuntimeError(403, 'MCP_ENDPOINT_DENIED', 'The MCP transport cannot leave its configured endpoint.');
    await beforeRequest?.({ url: current.href });
    signal?.throwIfAborted();
    const response = await fetch(current, { ...options, redirect: 'error', signal: options.signal && signal ? AbortSignal.any([options.signal, signal]) : signal || options.signal });
    if (!response.body) return response;
    let bytes = 0;
    const body = response.body.pipeThrough(new TransformStream({ transform(chunk, controller) {
      bytes += chunk.byteLength;
      if (bytes > 1_000_000) throw new HarnessRuntimeError(413, 'MCP_OUTPUT_TOO_LARGE', 'The MCP response exceeds its transport limit.');
      controller.enqueue(chunk);
    } }));
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
  return { isolation: 'remote-service', transport: new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: { headers: server.headers, redirect: 'error' }, fetch: guardedFetch,
    reconnectionOptions: { initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1, maxRetries: 0 }
  }) };
}
