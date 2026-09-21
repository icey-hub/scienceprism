import { TUNNEL_MODE } from '../config/constants.js';

/**
 * Try to start a tunnel using the configured provider.
 * Returns { url, provider } on success, null on skip/failure.
 * Never throws — tunnel failure is non-fatal.
 */
export async function tryStartTunnel(port) {
  const mode = TUNNEL_MODE.toLowerCase().trim();

  if (mode === 'false' || mode === '0' || mode === 'no') {
    return null;
  }

  if (mode === 'auto') {
    return (
      (await tryLocaltunnel(port)) ||
      (await tryCloudflared(port)) ||
      (await tryNgrok(port)) ||
      null
    );
  }

  if (mode === 'localtunnel') return tryLocaltunnel(port);
  if (mode === 'cloudflared') return tryCloudflared(port);
  if (mode === 'ngrok') return tryNgrok(port);

  console.warn(`[tunnel] Unknown SCIENCEPRISM_TUNNEL value: "${TUNNEL_MODE}", skipping.`);
  return null;
}

async function tryLocaltunnel(port) {
  try {
    const { default: localtunnel } = await import('localtunnel');
    const tunnel = await localtunnel({ port });

    tunnel.on('error', (err) => {
      console.warn(`[tunnel] localtunnel error: ${err.message}`);
    });

    tunnel.on('close', () => {
      console.warn('[tunnel] localtunnel closed, reconnecting in 3s...');
      setTimeout(async () => {
        try {
          const newTunnel = await localtunnel({ port });
          newTunnel.on('error', (e) => console.warn(`[tunnel] localtunnel error: ${e.message}`));
          newTunnel.on('close', () => console.warn('[tunnel] localtunnel closed again.'));
          console.log(`[tunnel] Reconnected: ${newTunnel.url}`);
        } catch (e) {
          console.warn(`[tunnel] Reconnect failed: ${e.message}`);
        }
      }, 3000);
    });

    return { url: tunnel.url, provider: 'localtunnel' };
  } catch {
    return null;
  }
}

async function tryCloudflared(port) {
  try {
    const { spawn } = await import('node:child_process');
    const url = await new Promise((resolve, reject) => {
      const proc = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${port}`], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let resolved = false;
      const timer = setTimeout(() => {
        if (!resolved) { resolved = true; reject(new Error('timeout')); }
      }, 30000);

      const onData = (data) => {
        const text = data.toString();
        const match = text.match(/https:\/\/[^\s]+\.trycloudflare\.com/);
        if (match && !resolved) {
          resolved = true;
          clearTimeout(timer);
          resolve(match[0]);
        }
      };
      proc.stdout.on('data', onData);
      proc.stderr.on('data', onData);
      proc.on('error', () => { if (!resolved) { resolved = true; clearTimeout(timer); reject(new Error('not installed')); } });
    });
    return { url, provider: 'cloudflared' };
  } catch {
    return null;
  }
}

async function tryNgrok(port) {
  try {
    const ngrok = await import('@ngrok/ngrok');
    const listener = await ngrok.default.forward({ addr: port, authtoken_from_env: true });
    return { url: listener.url(), provider: 'ngrok' };
  } catch {
    return null;
  }
}
