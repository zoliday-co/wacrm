// ============================================================
// The Oliday pipeline — reuses WACRM's pipelines / pipeline_stages
// / deals. `ensureTravelPipeline` creates (once per account) the
// pipeline + stages with `stage_key` set, and records its id in
// travel_settings.pipeline_id. `stageIdForStatus` resolves a lead
// status to the deal stage to move to.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import type { PipelineStage } from '@/types';
import type { TravelLeadStatus } from '@/types/travel';
import { TRAVEL_PIPELINE_NAME, TRAVEL_STAGES } from './constants';
import { getTravelSettings } from './settings';

export interface TravelPipeline {
  pipelineId: string;
  stages: PipelineStage[];
}

/**
 * Find or create the account's Oliday pipeline. `auditUserId` is
 * stamped on `pipelines.user_id` (NOT NULL audit column).
 */
export async function ensureTravelPipeline(
  db: SupabaseClient,
  accountId: string,
  auditUserId: string
): Promise<TravelPipeline> {
  const settings = await getTravelSettings(db, accountId);

  let pipelineId = settings.pipeline_id;
  if (pipelineId) {
    const { data: exists } = await db
      .from('pipelines')
      .select('id')
      .eq('id', pipelineId)
      .eq('account_id', accountId)
      .maybeSingle();
    if (!exists) pipelineId = null;
  }

  if (!pipelineId) {
    // A pipeline with the canonical name may already exist (e.g. an
    // admin re-created settings). Reuse it rather than duplicating.
    const { data: byName } = await db
      .from('pipelines')
      .select('id')
      .eq('account_id', accountId)
      .eq('name', TRAVEL_PIPELINE_NAME)
      .order('created_at', { ascending: true })
      .limit(1);
    if (byName && byName.length) {
      pipelineId = byName[0].id as string;
    } else {
      const { data: created, error } = await db
        .from('pipelines')
        .insert({ account_id: accountId, user_id: auditUserId, name: TRAVEL_PIPELINE_NAME })
        .select('id')
        .single();
      if (error || !created) {
        throw new Error(`Failed to create travel pipeline: ${error?.message ?? 'unknown'}`);
      }
      pipelineId = created.id as string;
    }
    await db
      .from('travel_settings')
      .update({ pipeline_id: pipelineId })
      .eq('account_id', accountId);
  }

  const stages = await ensureStages(db, pipelineId);
  return { pipelineId, stages };
}

async function ensureStages(db: SupabaseClient, pipelineId: string): Promise<PipelineStage[]> {
  const { data: existing } = await db
    .from('pipeline_stages')
    .select('*')
    .eq('pipeline_id', pipelineId)
    .order('position');
  const rows = (existing ?? []) as PipelineStage[];
  const byKey = new Map(rows.filter((r) => r.stage_key).map((r) => [r.stage_key as string, r]));

  const missing = TRAVEL_STAGES.filter((s) => !byKey.has(s.key));
  if (missing.length === 0) return rows;

  // Adopt same-named keyless stages first (a fork may have seeded them
  // manually), then insert whatever is still missing.
  const keyless = rows.filter((r) => !r.stage_key);
  const stillMissing: typeof TRAVEL_STAGES = [];
  for (const s of missing) {
    const adopt = keyless.find((r) => r.name.toLowerCase() === s.name.toLowerCase());
    if (adopt) {
      await db.from('pipeline_stages').update({ stage_key: s.key }).eq('id', adopt.id);
    } else {
      stillMissing.push(s);
    }
  }
  if (stillMissing.length) {
    const basePosition = rows.length;
    await db.from('pipeline_stages').insert(
      stillMissing.map((s, i) => ({
        pipeline_id: pipelineId,
        name: s.name,
        color: s.color,
        position: basePosition + TRAVEL_STAGES.findIndex((t) => t.key === s.key) + i,
        stage_key: s.key,
      }))
    );
  }

  const { data: reloaded } = await db
    .from('pipeline_stages')
    .select('*')
    .eq('pipeline_id', pipelineId)
    .order('position');
  return (reloaded ?? []) as PipelineStage[];
}

export function stageIdForStatus(stages: PipelineStage[], status: TravelLeadStatus): string | null {
  return stages.find((s) => s.stage_key === status)?.id ?? null;
}

/** Deal `status` derived from the lead status. */
export function dealStatusForLead(status: TravelLeadStatus): 'open' | 'won' | 'lost' {
  if (status === 'BOOKING_CONFIRMED') return 'won';
  if (status === 'LOST') return 'lost';
  return 'open';
}
