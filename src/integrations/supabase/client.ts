import { createClient } from '@supabase/supabase-js';
import type { Database } from './types';

// These are PUBLIC anon keys — safe to hardcode.
// Supabase anon keys are designed to be exposed in frontend code.
// Row-level security on the Supabase side controls what the anon key can access.
//
// We hardcode them here instead of using import.meta.env because:
// - If the .env file is not committed to git (common), env vars are undefined at build time
// - createClient(undefined, undefined) throws "Invalid URL" synchronously
// - That crash happens before React mounts → blank page with no visible error
const SUPABASE_URL = "https://ukkicbsuyskkkluhpqrx.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_lGdXenKSzsG9-BnrsFH9SA_Q33J1oCW";

export const supabase = createClient<Database>(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    storage: localStorage,
    persistSession: true,
    autoRefreshToken: true,
  }
});
