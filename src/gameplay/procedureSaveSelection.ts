import type { Evidence } from './experienceMemory.js';

type EvidenceReference = Pick<Evidence,
  'id' | 'sequence' | 'sessionId' | 'worldId' | 'version' | 'dimension' | 'status' | 'verified'>;

export const PROCEDURE_REVISION_INSTRUCTIONS =
  'To revise a learned procedure, first demonstrate a changed sequence using ordinary operations. Then choose SAVE_PROCEDURE with procedure_id set to the presented parent ID, a name, fresh consecutive verified evidence_ids, and a nonempty reason describing your proposed change. The child starts as candidate with its own counters; the parent and all failures remain intact. Do not invent steps or revise an unchanged template just to reset its history; RUN_PROCEDURE can re-evaluate it instead. Verification means two confirmed replays since the latest actual failure, not guaranteed usefulness or safety; interrupted/unconfirmed attempts are recorded separately. Choose whether to retry or revise from the situation, not a prescribed progression.';

/** Validate a model selection, never choose a sequence or save one automatically.
 * The database repeats its authoritative validation at SAVE time. This boundary
 * additionally requires that every cited ID was actually presented to the model.
 */
export function validateProcedureSaveSelection(
  name: unknown,
  selectedIds: unknown,
  presentedEvidence: unknown,
  revision?: { parentId: unknown; reason: unknown; presentedProcedures: unknown },
): { procedureName: string; evidenceIds: string[]; procedureId?: string; reason?: string } {
  if (typeof name !== 'string' || !name.trim() || name.length > 120 ||
      !Array.isArray(selectedIds) || selectedIds.length < 2 || selectedIds.length > 12 ||
      selectedIds.some(id => typeof id !== 'string' || !id) ||
      new Set(selectedIds).size !== selectedIds.length) {
    throw new Error('procedure_invalid_request');
  }
  const ids = selectedIds as string[];
  const presented = Array.isArray(presentedEvidence) ? presentedEvidence : [];
  const byId = new Map(presented.filter(isEvidenceReference).map(trace => [trace.id, trace]));
  const traces = ids.map(id => {
    const trace = byId.get(id);
    if (!trace) throw new Error('procedure_evidence_not_presented');
    if (trace.status !== 'succeeded' || !trace.verified) {
      throw new Error('procedure_requires_verified_evidence');
    }
    return trace;
  });
  const first = traces[0];
  for (let i = 1; i < traces.length; i++) {
    const trace = traces[i];
    if (trace.sessionId !== first.sessionId || trace.worldId !== first.worldId ||
        trace.version !== first.version || trace.dimension !== first.dimension ||
        trace.sequence !== traces[i - 1].sequence + 1) {
      throw new Error('procedure_requires_contiguous_demonstration');
    }
  }
  const selection = { procedureName: name.trim(), evidenceIds: [...ids] };
  if (revision?.parentId == null) return selection;
  if (typeof revision.parentId !== 'string' || !revision.parentId.trim() || revision.parentId.length > 128 ||
      typeof revision.reason !== 'string' || !revision.reason.trim() || revision.reason.length > 300) {
    throw new Error('procedure_revision_invalid_request');
  }
  const parents: unknown[] = Array.isArray(revision.presentedProcedures) ? revision.presentedProcedures : [];
  if (!parents.some(parent => parent != null && typeof parent === 'object' &&
      (parent as Record<string, unknown>).id === revision.parentId)) throw new Error('procedure_revision_parent_not_presented');
  return { ...selection, procedureId: revision.parentId, reason: revision.reason.trim() };
}

function isEvidenceReference(value: unknown): value is EvidenceReference {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return ['id', 'sessionId', 'worldId', 'version', 'dimension'].every(key =>
    typeof row[key] === 'string' && (row[key] as string).length > 0,
  ) && Number.isSafeInteger(row.sequence) && Number(row.sequence) > 0 &&
    ['succeeded', 'failed', 'interrupted'].includes(String(row.status)) && typeof row.verified === 'boolean';
}
