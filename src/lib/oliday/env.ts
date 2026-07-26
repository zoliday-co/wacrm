// ============================================================
// Oliday bot enablement + catalog connection config.
//
// The bot is a deployment-level feature of this fork: it turns on
// only when the operator has provided the catalog project's
// credentials AND flipped BOT_ENABLED. The Gemini key itself follows
// the fork's per-account BYO-key pattern (ai_configs.api_key with
// provider='gemini') — there is deliberately no GEMINI_API_KEY env.
// ============================================================

export interface CatalogEnv {
  url: string;
  anonKey: string;
}

/** The catalog lives in a SEPARATE Supabase project from the CRM —
 *  hence its own vars rather than reusing NEXT_PUBLIC_SUPABASE_URL. */
export function catalogEnv(): CatalogEnv | null {
  const url = process.env.OLIDAY_CATALOG_SUPABASE_URL;
  const anonKey = process.env.OLIDAY_CATALOG_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;
  return { url, anonKey };
}

/** Global kill switch + config completeness. `BOT_ENABLED=false` stops
 *  the Oliday agent instantly without touching the generic AI
 *  auto-reply the fork already had. */
export function isOlidayBotEnabled(): boolean {
  if (process.env.BOT_ENABLED !== 'true') return false;
  return catalogEnv() !== null;
}
