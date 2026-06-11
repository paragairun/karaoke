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
const SUPABASE_URL = "https://wnfgqlywaecvbptjvktt.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InduZmdxbHl3YWVjdmJwdGp2a3R0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjcxMDA4NjQsImV4cCI6MjA4MjY3Njg2NH0.sUS0O951-8VsJYOWTJr0mXF4D4X6rU3MkxOWiSLFVYA";

export const supabase = createClient<Database>(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    storage: localStorage,
    persistSession: true,
    autoRefreshToken: true,
  }
});
