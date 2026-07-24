// Hand-written to match supabase/migrations/0001_core.sql.
// Regenerate once linked to a project: pnpm --filter @nightjar/db gen
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: { id: string; display_name: string | null; created_at: string };
        Insert: { id: string; display_name?: string | null; created_at?: string };
        Update: { id?: string; display_name?: string | null; created_at?: string };
        Relationships: [];
      };
      sites: {
        Row: { id: string; owner_id: string; name: string; created_at: string };
        Insert: { id?: string; owner_id: string; name?: string; created_at?: string };
        Update: { id?: string; owner_id?: string; name?: string; created_at?: string };
        Relationships: [];
      };
      nodes: {
        Row: {
          id: string;
          site_id: string | null;
          name: string;
          claim_code: string | null;
          claim_code_expires_at: string | null;
          node_secret_hash: string;
          status: "unclaimed" | "online" | "offline";
          last_seen_at: string | null;
          version: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          site_id?: string | null;
          name?: string;
          claim_code?: string | null;
          claim_code_expires_at?: string | null;
          node_secret_hash: string;
          status?: "unclaimed" | "online" | "offline";
          last_seen_at?: string | null;
          version?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          site_id?: string | null;
          name?: string;
          claim_code?: string | null;
          claim_code_expires_at?: string | null;
          node_secret_hash?: string;
          status?: "unclaimed" | "online" | "offline";
          last_seen_at?: string | null;
          version?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      cameras: {
        Row: {
          id: string;
          node_id: string;
          name: string;
          make: string | null;
          model: string | null;
          capabilities: Json;
          enabled: boolean;
          created_at: string;
        };
        Insert: {
          id: string;
          node_id: string;
          name: string;
          make?: string | null;
          model?: string | null;
          capabilities?: Json;
          enabled?: boolean;
          created_at?: string;
        };
        Update: {
          id?: string;
          node_id?: string;
          name?: string;
          make?: string | null;
          model?: string | null;
          capabilities?: Json;
          enabled?: boolean;
          created_at?: string;
        };
        Relationships: [];
      };
      events: {
        Row: {
          id: string;
          node_id: string;
          camera_id: string;
          kind: "motion" | "person" | "vehicle" | "animal" | "package";
          score: number;
          started_at: string;
          ended_at: string | null;
          clip_status: "local" | "uploading" | "uploaded" | "expired";
          thumbnail_path: string | null;
          metadata: Json;
          created_at: string;
        };
        Insert: {
          id: string;
          node_id: string;
          camera_id: string;
          kind: "motion" | "person" | "vehicle" | "animal" | "package";
          score?: number;
          started_at: string;
          ended_at?: string | null;
          clip_status?: "local" | "uploading" | "uploaded" | "expired";
          thumbnail_path?: string | null;
          metadata?: Json;
          created_at?: string;
        };
        Update: {
          id?: string;
          node_id?: string;
          camera_id?: string;
          kind?: "motion" | "person" | "vehicle" | "animal" | "package";
          score?: number;
          started_at?: string;
          ended_at?: string | null;
          clip_status?: "local" | "uploading" | "uploaded" | "expired";
          thumbnail_path?: string | null;
          metadata?: Json;
          created_at?: string;
        };
        Relationships: [];
      };
      event_clips: {
        Row: {
          id: string;
          event_id: string;
          storage_path: string;
          bytes: number | null;
          duration_s: number | null;
          expires_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          event_id: string;
          storage_path: string;
          bytes?: number | null;
          duration_s?: number | null;
          expires_at?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          event_id?: string;
          storage_path?: string;
          bytes?: number | null;
          duration_s?: number | null;
          expires_at?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      subscriptions: {
        Row: {
          id: string;
          owner_id: string;
          plan: "free" | "plus" | "pro";
          status: string;
          stripe_customer_id: string | null;
          stripe_subscription_id: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          owner_id: string;
          plan?: "free" | "plus" | "pro";
          status?: string;
          stripe_customer_id?: string | null;
          stripe_subscription_id?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          owner_id?: string;
          plan?: "free" | "plus" | "pro";
          status?: string;
          stripe_customer_id?: string | null;
          stripe_subscription_id?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      notification_settings: {
        Row: {
          user_id: string;
          camera_id: string | null;
          kinds: string[];
          channels: Json;
          muted_until: string | null;
        };
        Insert: {
          user_id: string;
          camera_id?: string | null;
          kinds?: string[];
          channels?: Json;
          muted_until?: string | null;
        };
        Update: {
          user_id?: string;
          camera_id?: string | null;
          kinds?: string[];
          channels?: Json;
          muted_until?: string | null;
        };
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      user_owns_node: { Args: { p_node_id: string }; Returns: boolean };
      jwt_node_id: { Args: Record<string, never>; Returns: string };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
