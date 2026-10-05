import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

const isConfigured = Boolean(url && anonKey && !url.includes("xxxx") && anonKey !== "...");

/**
 * Browser Supabase client for querying your tables directly (with Row Level Security).
 * Sign-in is handled by the backend (/auth/login/google), so this is not used for auth
 * on the starter page — it's here ready for your hackathon features. `null` until
 * VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are filled in.
 */
export const supabase: SupabaseClient | null = isConfigured ? createClient(url, anonKey) : null;
