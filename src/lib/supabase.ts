import { createClient, type SupabaseClient } from '@supabase/supabase-js'

export type Row = {
  id: string
  label: string
  amount: number
  sort_order: number
  excluded?: boolean
  memo?: string
  locked?: boolean
  boxed?: boolean
}

export type SubCard = {
  id: string
  cashflow_card_id: string
  name: string
  sort_order: number
  rows: Row[]
}

export type CashFlowCard = {
  id: string
  name: string
  sort_order: number
  created_at?: string
}

export type Database = {
  public: {
    Tables: {
      cashflow_app_settings: {
        Row: { id: string; pin_hash: string; updated_at: string }
        Insert: { id?: string; pin_hash: string; updated_at?: string }
        Update: { id?: string; pin_hash?: string; updated_at?: string }
        Relationships: []
      }
      cashflow_cards: {
        Row: { id: string; name: string; sort_order: number; created_at: string }
        Insert: { id?: string; name: string; sort_order?: number; created_at?: string }
        Update: { id?: string; name?: string; sort_order?: number }
        Relationships: []
      }
      cashflow_sub_cards: {
        Row: {
          id: string
          cashflow_card_id: string
          name: string
          sort_order: number
          rows: Row[]
          created_at: string
        }
        Insert: {
          id?: string
          cashflow_card_id: string
          name: string
          sort_order?: number
          rows?: Row[]
          created_at?: string
        }
        Update: { id?: string; name?: string; sort_order?: number; rows?: Row[] }
        Relationships: []
      }
    }
    Views: Record<string, never>
    Functions: Record<string, never>
    Enums: Record<string, never>
    CompositeTypes: Record<string, never>
  }
}

let supabaseClient: SupabaseClient<Database> | null = null

function getSupabaseUrl() {
  return String(import.meta.env.VITE_SUPABASE_URL ?? '').trim()
}

function getSupabaseAnonKey() {
  return String(import.meta.env.VITE_SUPABASE_ANON_KEY ?? '').trim()
}

export function isSupabaseConfigured() {
  return Boolean(getSupabaseUrl() && getSupabaseAnonKey())
}

export function getSupabaseClient() {
  if (supabaseClient) return supabaseClient

  const url = getSupabaseUrl()
  const key = getSupabaseAnonKey()

  if (!url || !key) {
    throw new Error('Supabase 환경 변수가 설정되지 않았어요.')
  }

  supabaseClient = createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  return supabaseClient
}
