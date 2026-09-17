import { ReflexLayer } from '../cognitive/reflexLayer.js';
import { installGameplayReflexPolicy } from './reflexPolicy.js';

const originalConnect = ReflexLayer.prototype.connect;

ReflexLayer.prototype.connect = async function patchedGameplayConnect(
  options,
  events,
): Promise<void> {
  installGameplayReflexPolicy(this, (this as any).shared);
  return originalConnect.call(this, options, events);
};

await import('../gameplay.js');
