import type { Evidence } from './experienceMemory.js';

type EvidenceReference = Pick<Evidence,
  'id' | 'sequence' | 'sessionId' | 'worldId' | 'version' | 'dimension' | 'status' | 'verified'>;

/** Validate a model selection, never choose a sequence or save one automatically.
 * The database repeats its authoritative validation at SAVE time. This boundary
 * additionally requires that every cited ID was actually presented to the model.
 */
export function validateProcedureSaveSelection(
  name: unknown,
  selectedIds: unknown,
  presentedEvidence: unknown,
): { procedureName: string; evidenceIds: string[] } {
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
  return { procedureName: name.trim(), evidenceIds: [...ids] };
}

function isEvidenceReference(value: unknown): value is EvidenceReference {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return ['id', 'sessionId', 'worldId', 'version', 'dimension'].every(key =>
    typeof row[key] === 'string' && (row[key] as string).length > 0,
  ) && Number.isSafeInteger(row.sequence) && Number(row.sequence) > 0 &&
    ['succeeded', 'failed', 'interrupted'].includes(String(row.status)) && typeof row.verified === 'boolean';
}
