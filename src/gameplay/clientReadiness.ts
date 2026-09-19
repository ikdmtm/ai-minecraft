import type mineflayer from 'mineflayer';

/** 1.21.4 compatibility for the pinned Mineflayer 4.35.0 client.
 * Notify the server only after its level-load announcement, an actual player
 * position and the local column are available. This is a protocol handshake,
 * not a gameplay action or an assumption that an operation succeeded.
 * Revisit when upgrading Mineflayer: upstream PR #4064 addresses this lifecycle.
 */
export function attachClientReadiness(bot: mineflayer.Bot): () => void {
  const client = (bot as any)._client;
  if (!client?.on || !client?.write) return () => {};
  let announced = false, positioned = false, sent = false;
  const reset = () => { announced = false; positioned = false; sent = false; };
  const ready = () => {
    if (bot.version !== '1.21.4' || !announced || !positioned || sent) return;
    const pos = bot.entity?.position;
    if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) return;
    try { if (!bot.blockAt(pos)) return; } catch { return; }
    sent = true;
    client.write('player_loaded', {});
  };
  const position = () => { positioned = true; ready(); };
  const announcement = (packet: { reason: number | string }) => {
    if (packet.reason !== 13 && packet.reason !== 'level_chunks_load_start') return;
    announced = true; ready();
  };
  const cleanup = () => {
    client.removeListener('login', reset); client.removeListener('respawn', reset);
    client.removeListener('game_state_change', announcement);
    bot.removeListener('forcedMove', position); bot.removeListener('chunkColumnLoad', ready);
    bot.removeListener('spawn', ready); bot.removeListener('end', cleanup);
  };
  client.on('login', reset); client.on('respawn', reset);
  client.on('game_state_change', announcement);
  bot.on('forcedMove', position); bot.on('chunkColumnLoad', ready); bot.on('spawn', ready);
  bot.once('end', cleanup);
  return cleanup;
}
