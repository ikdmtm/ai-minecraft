import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';

export interface WorldConnection { mcHost: string; mcPort: number; }
export interface GameplayWorldIdentity {
  /** Opaque configured/marker identity, not a seed. */
  worldToken: string;
  /** Spatial-memory namespace includes the configured server endpoint. */
  memoryWorldId: string;
  serverId: string;
  source: 'explicit' | 'marker' | 'session_unconfirmed';
  markerPath?: string;
}

function serverIdentity(connection: WorldConnection): string {
  const host = connection.mcHost.trim().toLowerCase();
  if (!host || !Number.isInteger(connection.mcPort) || connection.mcPort < 1 || connection.mcPort > 65535) {
    throw new Error('world_identity_invalid_server');
  }
  // Do not resolve aliases or use seed equality as proof of server/world identity.
  return createHash('sha256').update(JSON.stringify([host, connection.mcPort])).digest('hex');
}
function identity(
  connection: WorldConnection, worldToken: string,
  source: GameplayWorldIdentity['source'], markerPath?: string,
): GameplayWorldIdentity {
  if (!worldToken || worldToken.length > 1024 || /[\u0000-\u001f\u007f]/.test(worldToken)) {
    throw new Error('world_identity_invalid_token');
  }
  const serverId = serverIdentity(connection);
  const memoryWorldId = 'server-world:' + createHash('sha256')
    .update(JSON.stringify([serverId, worldToken])).digest('hex');
  return { worldToken, memoryWorldId, serverId, source, ...(markerPath ? { markerPath } : {}) };
}
function optionalText(path: string): string | undefined {
  try { return readFileSync(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error('world_identity_file_unreadable');
  }
}
function property(text: string, key: string, fallback: string): string {
  // Only the simple server.properties format emitted by this repo's setup script.
  const line = text.split(/\r?\n/).find(entry => entry.startsWith(key + '='));
  return line == null ? fallback : line.slice(key.length + 1).trim();
}

/** Resolve a stable identity only from explicit configuration or the managed local marker. */
export function resolveGameplayWorldIdentity(
  connection: WorldConnection, env: NodeJS.ProcessEnv = process.env,
): GameplayWorldIdentity {
  serverIdentity(connection); // Validate even when no marker is available.
  const explicit = env.GAMEPLAY_WORLD_ID?.trim();
  if (explicit) return identity(connection, explicit, 'explicit');

  const configuredFile = env.GAMEPLAY_WORLD_ID_FILE?.trim();
  if (configuredFile) {
    const path = resolve(configuredFile);
    const token = optionalText(path)?.trim();
    if (!token) throw new Error('world_identity_explicit_marker_missing_or_empty');
    return identity(connection, token, 'marker', path);
  }

  const host = connection.mcHost.trim().toLowerCase();
  if (['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) {
    const directory = resolve(env.MC_DEV_DIR || '.minecraft-dev', 'server');
    const properties = optionalText(resolve(directory, 'server.properties'));
    // A default marker must not be silently borrowed by a different local port,
    // a custom level directory, or a remote server. Those need an explicit marker.
    if (properties != null && property(properties, 'level-name', 'world') === 'world' &&
        property(properties, 'server-port', '25565') === String(connection.mcPort)) {
      const path = resolve(directory, 'world/.ai-world-id');
      const token = optionalText(path)?.trim();
      if (token) return identity(connection, token, 'marker', path);
    }
  }

  // Without a stable identity we cannot distinguish a restart from a replacement
  // world. Preserve global experience, but never reuse the last DB's live map.
  return identity(connection, randomUUID(), 'session_unconfirmed');
}

/** Called only by the explicit stopped-runtime generation transition. Never resets a world. */
export function advanceGameplayWorldIdentity(
  connection: WorldConnection, previous: GameplayWorldIdentity,
  env: NodeJS.ProcessEnv = process.env,
): GameplayWorldIdentity {
  const selected = resolveGameplayWorldIdentity(connection, env);
  if (selected.source === 'explicit' && selected.memoryWorldId === previous.memoryWorldId) {
    // Rotating just the DB would resurrect the old map on the next process start.
    throw new Error('world_identity_explicit_rotation_required');
  }
  if (selected.source !== 'marker' || selected.memoryWorldId !== previous.memoryWorldId) return selected;

  const token = randomUUID();
  const path = selected.markerPath!;
  const temporary = path + '.tmp-' + randomUUID();
  try {
    // Do not create a missing world directory. Update the marker before changing
    // the in-memory/DB namespace, so a failed write leaves the runtime unchanged.
    writeFileSync(temporary, token + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
  } catch {
    try { unlinkSync(temporary); } catch { /* best effort; never delete the marker */ }
    throw new Error('world_identity_marker_rotation_failed');
  }
  return identity(connection, token, 'marker', path);
}
