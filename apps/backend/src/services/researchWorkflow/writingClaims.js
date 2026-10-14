import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

/** Keep the original ledger identity rule; model/task ids remain unchanged. */
export const writingClaimEvidenceId=id=>`claim-${createHash('sha1').update(String(id)).digest('hex').slice(0,20)}`;
export function writingClaimMatchesLedger(claim,entry) {
  const ids=value=>Array.isArray(value)?[...new Set(value.map(String))].sort():[];
  return entry?.kind==='paper-claim'&&entry.id===writingClaimEvidenceId(claim.id)&&entry.title===claim.id
    &&(entry.summary||entry.title)===claim.text
    &&isDeepStrictEqual(ids(entry.metadata?.evidenceIds||Object.keys(entry.evidenceVersions||{})),ids(claim.evidenceIds))
    &&isDeepStrictEqual(entry.evidenceVersions||{},claim.evidenceVersions||{});
}
