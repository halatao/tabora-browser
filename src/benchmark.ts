import type { DecisionResult, ProviderId } from './shared.js';
export interface BenchmarkRow { provider:ProviderId; model:string; sample:number; expectedChoiceId?:string; result:DecisionResult; }
export function percentile(values: number[], p:number): number | null {
  if(!values.length)return null; const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.max(0,Math.ceil(p*sorted.length)-1)]!;
}
export function summarize(rows:BenchmarkRow[]) {
  return [...new Set(rows.map(r=>r.provider))].map(provider=>{
    const own=rows.filter(r=>r.provider===provider), success=own.filter(r=>r.result.status==='selected');
    const scored=own.filter(r=>r.expectedChoiceId!==undefined), priced=own.filter(r=>r.result.costUsd!==undefined);
    return {provider,runs:own.length,valid:success.length,failed:own.length-success.length,
      correct:scored.length?scored.filter(r=>r.result.status==='selected'&&r.result.choiceId===r.expectedChoiceId).length:null,scored:scored.length,
      // Failed fast requests never improve the successful-decision latency percentiles.
      p50:percentile(success.map(r=>r.result.latencyMs),0.5),p95:percentile(success.map(r=>r.result.latencyMs),0.95),
      costUsd:priced.length===own.length?priced.reduce((sum,r)=>sum+r.result.costUsd!,0):null};
  });
}
