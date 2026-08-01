import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { config } from '../config';

let supabaseInstance: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (!supabaseInstance) {
    supabaseInstance = createClient(config.supabase.url, config.supabase.serviceRoleKey, {
      auth: { persistSession: false },
    });
    console.log('[DB] Supabase client initialized');
  }
  return supabaseInstance;
}

export function getSupabaseAnon(): SupabaseClient {
  return createClient(config.supabase.url, config.supabase.anonKey, {
    auth: { persistSession: false },
  });
}
