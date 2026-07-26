export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      cameras: {
        Row: {
          capabilities: Json
          created_at: string
          enabled: boolean
          id: string
          make: string | null
          model: string | null
          name: string
          node_id: string
          zones: Json
        }
        Insert: {
          capabilities?: Json
          created_at?: string
          enabled?: boolean
          id: string
          make?: string | null
          model?: string | null
          name: string
          node_id: string
          zones?: Json
        }
        Update: {
          capabilities?: Json
          created_at?: string
          enabled?: boolean
          id?: string
          make?: string | null
          model?: string | null
          name?: string
          node_id?: string
          zones?: Json
        }
        Relationships: [
          {
            foreignKeyName: "cameras_node_id_fkey"
            columns: ["node_id"]
            isOneToOne: false
            referencedRelation: "nodes"
            referencedColumns: ["id"]
          },
        ]
      }
      clip_shares: {
        Row: {
          caption: string | null
          created_at: string | null
          event_id: string
          expires_at: string
          id: string
          owner_id: string
          revoked_at: string | null
          token: string
          view_count: number
        }
        Insert: {
          caption?: string | null
          created_at?: string | null
          event_id: string
          expires_at: string
          id?: string
          owner_id: string
          revoked_at?: string | null
          token: string
          view_count?: number
        }
        Update: {
          caption?: string | null
          created_at?: string | null
          event_id?: string
          expires_at?: string
          id?: string
          owner_id?: string
          revoked_at?: string | null
          token?: string
          view_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "clip_shares_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "clip_shares_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      event_clips: {
        Row: {
          bytes: number | null
          created_at: string
          duration_s: number | null
          event_id: string
          expires_at: string | null
          id: string
          storage_path: string
        }
        Insert: {
          bytes?: number | null
          created_at?: string
          duration_s?: number | null
          event_id: string
          expires_at?: string | null
          id?: string
          storage_path: string
        }
        Update: {
          bytes?: number | null
          created_at?: string
          duration_s?: number | null
          event_id?: string
          expires_at?: string | null
          id?: string
          storage_path?: string
        }
        Relationships: [
          {
            foreignKeyName: "event_clips_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: true
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
        ]
      }
      events: {
        Row: {
          camera_id: string
          clip_status: string
          created_at: string
          ended_at: string | null
          id: string
          kind: string
          metadata: Json
          node_id: string
          score: number
          started_at: string
          thumbnail_path: string | null
        }
        Insert: {
          camera_id: string
          clip_status?: string
          created_at?: string
          ended_at?: string | null
          id: string
          kind: string
          metadata?: Json
          node_id: string
          score?: number
          started_at: string
          thumbnail_path?: string | null
        }
        Update: {
          camera_id?: string
          clip_status?: string
          created_at?: string
          ended_at?: string | null
          id?: string
          kind?: string
          metadata?: Json
          node_id?: string
          score?: number
          started_at?: string
          thumbnail_path?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "events_camera_id_fkey"
            columns: ["camera_id"]
            isOneToOne: false
            referencedRelation: "cameras"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "events_node_id_fkey"
            columns: ["node_id"]
            isOneToOne: false
            referencedRelation: "nodes"
            referencedColumns: ["id"]
          },
        ]
      }
      nodes: {
        Row: {
          claim_code: string | null
          claim_code_expires_at: string | null
          created_at: string
          id: string
          last_seen_at: string | null
          name: string
          node_secret_hash: string
          site_id: string | null
          status: string
          version: string | null
        }
        Insert: {
          claim_code?: string | null
          claim_code_expires_at?: string | null
          created_at?: string
          id?: string
          last_seen_at?: string | null
          name?: string
          node_secret_hash: string
          site_id?: string | null
          status?: string
          version?: string | null
        }
        Update: {
          claim_code?: string | null
          claim_code_expires_at?: string | null
          created_at?: string
          id?: string
          last_seen_at?: string | null
          name?: string
          node_secret_hash?: string
          site_id?: string | null
          status?: string
          version?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "nodes_site_id_fkey"
            columns: ["site_id"]
            isOneToOne: false
            referencedRelation: "sites"
            referencedColumns: ["id"]
          },
        ]
      }
      notification_deliveries: {
        Row: {
          camera_id: string
          channel: string
          id: string
          kind: string
          sent_at: string
          user_id: string
        }
        Insert: {
          camera_id: string
          channel?: string
          id?: string
          kind: string
          sent_at?: string
          user_id: string
        }
        Update: {
          camera_id?: string
          channel?: string
          id?: string
          kind?: string
          sent_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "notification_deliveries_camera_id_fkey"
            columns: ["camera_id"]
            isOneToOne: false
            referencedRelation: "cameras"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notification_deliveries_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      notification_settings: {
        Row: {
          camera_id: string | null
          channels: Json
          id: string
          kinds: string[]
          muted_until: string | null
          user_id: string
        }
        Insert: {
          camera_id?: string | null
          channels?: Json
          id?: string
          kinds?: string[]
          muted_until?: string | null
          user_id: string
        }
        Update: {
          camera_id?: string | null
          channels?: Json
          id?: string
          kinds?: string[]
          muted_until?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "notification_settings_camera_id_fkey"
            columns: ["camera_id"]
            isOneToOne: false
            referencedRelation: "cameras"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notification_settings_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          created_at: string
          display_name: string | null
          id: string
          notify_email: string | null
          notify_phone: string | null
        }
        Insert: {
          created_at?: string
          display_name?: string | null
          id: string
          notify_email?: string | null
          notify_phone?: string | null
        }
        Update: {
          created_at?: string
          display_name?: string | null
          id?: string
          notify_email?: string | null
          notify_phone?: string | null
        }
        Relationships: []
      }
      push_subscriptions: {
        Row: {
          auth: string
          created_at: string
          endpoint: string
          id: string
          last_used_at: string
          p256dh: string
          user_agent: string | null
          user_id: string
        }
        Insert: {
          auth: string
          created_at?: string
          endpoint: string
          id?: string
          last_used_at?: string
          p256dh: string
          user_agent?: string | null
          user_id: string
        }
        Update: {
          auth?: string
          created_at?: string
          endpoint?: string
          id?: string
          last_used_at?: string
          p256dh?: string
          user_agent?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "push_subscriptions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      sites: {
        Row: {
          created_at: string
          id: string
          name: string
          owner_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          name?: string
          owner_id: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          owner_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "sites_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      subscriptions: {
        Row: {
          created_at: string
          id: string
          owner_id: string
          plan: string
          status: string
          stripe_customer_id: string | null
          stripe_subscription_id: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          owner_id: string
          plan?: string
          status?: string
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          owner_id?: string
          plan?: string
          status?: string
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "subscriptions_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      jwt_node_id: { Args: never; Returns: string }
      user_owns_node: { Args: { p_node_id: string }; Returns: boolean }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
