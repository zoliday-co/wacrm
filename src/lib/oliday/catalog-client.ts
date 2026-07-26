import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { catalogEnv } from './env';

// Lazy singleton, same pattern as the webhook's admin client. The anon
// key is read-only by RLS design (SELECT on the `active_packages`
// view only), so this client can never write — lead logging goes
// through the CRM's own tables with its own service-role client.
let _client: SupabaseClient | null = null;

export function catalogClient(): SupabaseClient {
  if (!_client) {
    const env = catalogEnv();
    if (!env) {
      throw new Error(
        'Oliday catalog is not configured — set OLIDAY_CATALOG_SUPABASE_URL and OLIDAY_CATALOG_SUPABASE_ANON_KEY'
      );
    }
    _client = createClient(env.url, env.anonKey, {
      auth: { persistSession: false },
    });
  }
  return _client;
}
