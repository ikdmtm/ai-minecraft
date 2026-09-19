/** Adapter smoke test, never an autonomous-survival benchmark. Uses its own disposable world. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, copyFileSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import mineflayer from 'mineflayer';
import { attachClientReadiness } from '../src/gameplay/clientReadiness.js';
import { pathfinder } from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { executePrimitiveOperation, windowSnapshot, type PrimitiveOperation } from '../src/gameplay/primitiveOperations.js';

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(test: () => boolean, label: string, ms = 15000) {
  const end = Date.now() + ms;
  while (!test()) { if (Date.now() > end) throw new Error(`smoke_timeout:${label}`); await delay(100); }
}
async function freePort(): Promise<number> {
  const socket = createServer();
  return new Promise((resolvePort, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => {
      const port = (socket.address() as { port: number }).port;
      socket.close(error => error ? reject(error) : resolvePort(port));
    });
  });
}
async function main() {
  const directory = mkdtempSync(join(tmpdir(), 'minecraft-autonomy-smoke-'));
  const source = process.env.GAMEPLAY_SMOKE_JAR || resolve(process.env.MC_DEV_DIR || '.minecraft-dev', 'server/server.jar');
  let bot: mineflayer.Bot | undefined;
  let server: ReturnType<typeof spawn> | undefined;
  let serverLog = '';
  let live = true;
  const context = { assertActive: () => { if (!live) throw new Error('smoke_stopped'); } };
  try {
    copyFileSync(source, join(directory, 'server.jar'));
    const factsPath = join(directory, 'facts.json');
    const exportResult = spawnSync('python3', [resolve('scripts/mc-export-knowledge.py'), join(directory, 'server.jar'), factsPath], { encoding: 'utf8' });
    assert.equal(exportResult.status, 0, exportResult.stderr);
    const facts = JSON.parse(readFileSync(factsPath, 'utf8'));
    assert.equal(facts.version, '1.21.4');
    assert.ok(Object.keys(facts.recipes).length > 100);
    console.log(exportResult.stdout.trim());
    const port = await freePort();
    writeFileSync(join(directory, 'eula.txt'), 'eula=true\n');
    writeFileSync(join(directory, 'server.properties'), [
      'server-ip=127.0.0.1', `server-port=${port}`, 'online-mode=false',
      'level-name=fixture-world', 'difficulty=hard', 'gamemode=survival',
      'spawn-protection=0', 'view-distance=3', 'simulation-distance=3',
      'allow-flight=true', 'enable-rcon=false', 'max-players=1', 'level-seed=8675309',
    ].join('\n') + '\n');
    server = spawn('java', ['-Xms512M', '-Xmx2G', '-jar', 'server.jar', 'nogui'], { cwd: directory, stdio: ['pipe', 'pipe', 'pipe'] });
    server.stdout!.on('data', chunk => { serverLog += chunk.toString(); });
    server.stderr!.on('data', chunk => { serverLog += chunk.toString(); });
    let serverError: Error | undefined;
    server.on('error', e => { serverError = e; });
    await until(() => { if (serverError) throw serverError; if (server!.exitCode != null) throw new Error(serverLog); return serverLog.includes('Done ('); }, 'server_ready', 120000);
    const command = (text: string) => server!.stdin!.write(text + '\n');
    command('gamerule doMobSpawning false'); command('gamerule doDaylightCycle false');
    command('gamerule spawnChunkRadius 0'); command('time set day');
    bot = mineflayer.createBot({ host: '127.0.0.1', port, username: 'AdapterSmoke', version: '1.21.4' });
    attachClientReadiness(bot);
    bot.loadPlugin(pathfinder);
    let spawned = false, connectionError: Error | undefined;
    bot.on('error', e => { connectionError = e; }); bot.once('spawn', () => { spawned = true; });
    await until(() => { if (connectionError) throw connectionError; return spawned; }, 'bot_spawn', 30000);
    const ox = Math.floor(bot.entity.position.x), oz = Math.floor(bot.entity.position.z);
    command(`fill ${ox-8} 200 ${oz-8} ${ox+8} 200 ${oz+8} minecraft:stone`);
    command(`tp AdapterSmoke ${ox+0.5} 201 ${oz+0.5}`);
    await until(() => bot!.entity.position.distanceTo(new Vec3(ox+0.5, 201, oz+0.5)) < 1, 'fixture_position');
    command('give AdapterSmoke minecraft:furnace 1');
    command('give AdapterSmoke minecraft:chicken 2');
    command('give AdapterSmoke minecraft:oak_planks 2');
    command('give AdapterSmoke minecraft:oak_log 2');
    command('give AdapterSmoke minecraft:wooden_pickaxe 1');
    await until(() => ['furnace', 'chicken', 'oak_planks', 'oak_log', 'wooden_pickaxe'].every(name => bot!.inventory.items().some(i => i.name === name)), 'fixture_items');
    const run = async (op: PrimitiveOperation) => {
      console.log(JSON.stringify({ phase: 'before', operation: op, position: bot!.entity.position, held: bot!.heldItem?.name, onGround: bot!.entity.onGround }));
      const result = await executePrimitiveOperation(bot!, op, context);
      console.log(JSON.stringify({ operation: op, result })); return result;
    };
    const count = (name: string) => bot!.inventory.items()
      .filter(item => item.name === name)
      .reduce((sum, item) => sum + item.count, 0);
    const p = { x: ox+1, y: 201, z: oz };
    const tablePos = { x: ox-1, y: 201, z: oz };
    await until(() => bot!.blockAt(new Vec3(ox+1, 200, oz))?.name === 'stone', 'fixture_chunk');
    await until(() => bot!.entity.onGround && Math.abs(bot!.entity.position.y - 201) < 0.01, 'fixture_grounded');
    await bot.waitForTicks(5);

    const logBefore = count('oak_log');
    const planksBefore = count('oak_planks');
    await run({ action: 'CRAFT', item: 'oak_planks', count: 2 });
    assert.equal(count('oak_log'), logBefore - 2);
    assert.equal(count('oak_planks'), planksBefore + 8);

    const sticksBefore = count('stick');
    await run({ action: 'CRAFT', item: 'stick', count: 1 });
    assert.equal(count('stick'), sticksBefore + 4);

    await run({ action: 'CRAFT', item: 'crafting_table', count: 1 });
    assert.equal(count('crafting_table'), 1);
    await run({ action: 'PLACE', position: tablePos, item: 'crafting_table' });
    assert.equal(bot.blockAt(new Vec3(tablePos.x, tablePos.y, tablePos.z))?.name, 'crafting_table');

    const pickaxesBefore = count('wooden_pickaxe');
    await run({ action: 'CRAFT', item: 'wooden_pickaxe', count: 1 });
    assert.equal(count('wooden_pickaxe'), pickaxesBefore + 1);
    console.log('REAL_SERVER_CRAFT_PASSED: inventory-recipe and crafting-table-recipe outputs verified');

    await run({ action: 'PLACE', position: p, item: 'furnace' });
    assert.equal(bot.blockAt(new Vec3(p.x, p.y, p.z))?.name, 'furnace');
    await run({ action: 'OPEN', position: p });
    const slots = () => windowSnapshot(bot!);
    assert.deepEqual(slots().slots.slice(0, 3).map(s => s.role), ['smelted', 'fuel', 'result']);
    const transfer = async (name: string, destinationSlot: number) => {
      const sourceSlot = slots().slots.find(s => s.zone === 'inventory' && s.item === name)!.index;
      await run({ action: 'TRANSFER', windowId: slots().id, sourceSlot, destinationSlot, item: name, count: 1 });
    };
    await transfer('chicken', 0); await transfer('oak_planks', 1);
    await run({ action: 'WAIT', until: 'window_changed', durationMs: 15000 });
    await until(() => slots().slots[2].item === 'cooked_chicken', 'cooked_output');
    const destination = slots().slots.find(s => s.zone === 'inventory' && !s.item)!.index;
    await run({ action: 'TRANSFER', windowId: slots().id, sourceSlot: 2, destinationSlot: destination, item: 'cooked_chicken', count: 1 });
    await run({ action: 'CLOSE', windowId: slots().id });
    await until(() => bot!.inventory.items().some(i => i.name === 'cooked_chicken'), 'output_in_inventory');

    // A strong, short Hunger effect deterministically burns through initial
    // saturation so USE can be verified from a real food-level increase.
    command('effect give AdapterSmoke minecraft:hunger 3 255 true');
    await until(() => bot!.food <= 14, 'hunger_reduced_for_use', 8000);
    command('effect clear AdapterSmoke minecraft:hunger');
    const hungerBefore = bot.food;
    const cookedBefore = count('cooked_chicken');
    await run({ action: 'USE', item: 'cooked_chicken' });
    await until(() => bot!.food > hungerBefore, 'food_hunger_increased', 5000);
    assert.equal(count('cooked_chicken'), cookedBefore - 1);
    assert.ok(bot.food > hungerBefore);
    console.log(JSON.stringify({ phase: 'use_verified', item: 'cooked_chicken', hunger_before: hungerBefore, hunger_after: bot.food }));
    console.log('REAL_SERVER_USE_PASSED: selected food consumed and hunger increased');

    await run({ action: 'EQUIP', item: 'wooden_pickaxe' });
    await run({ action: 'BREAK', position: p });
    assert.equal(bot.blockAt(new Vec3(p.x, p.y, p.z))?.name, 'air');
    await run({ action: 'MOVE', position: p });
    await until(() => bot!.inventory.items().some(i => i.name === 'furnace'), 'normal_drop_pickup');
    console.log('REAL_SERVER_SMOKE_PASSED: craft/use/place/open/transfer/process-output/close/equip/break/move/pickup');
  } finally {
    live = false; try { bot?.quit(); } catch { /* best effort */ }
    if (server && server.exitCode == null) {
      server.stdin?.write('stop\n');
      try { await until(() => server!.exitCode != null, 'server_stop', 12000); } catch { server.kill('SIGKILL'); }
    }
    mkdirSync('data', { recursive: true }); writeFileSync('data/autonomy-smoke-server.log', serverLog);
    rmSync(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
