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
    PostgrestVersion: "14.18"
  }
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      claude_call_claims: {
        Row: {
          claimed_at: string
          day: string
          id: number
          released_at: string | null
          user_id: string
        }
        Insert: {
          claimed_at?: string
          day: string
          id?: number
          released_at?: string | null
          user_id: string
        }
        Update: {
          claimed_at?: string
          day?: string
          id?: number
          released_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      claude_usage_daily: {
        Row: {
          calls: number
          day: string
          user_id: string
        }
        Insert: {
          calls?: number
          day: string
          user_id: string
        }
        Update: {
          calls?: number
          day?: string
          user_id?: string
        }
        Relationships: []
      }
      emails: {
        Row: {
          body_envelope: Json | null
          body_state: string
          classification: string | null
          created_at: string
          error: string | null
          forwarding_confirm_url: string | null
          from_address: string | null
          from_domain: string | null
          from_name: string | null
          html_body: string | null
          id: string
          message_id: string | null
          processing_status: string
          provider_email_id: string | null
          received_at: string
          sent_at: string | null
          subject: string | null
          text_body: string | null
          user_id: string
        }
        Insert: {
          body_envelope?: Json | null
          body_state?: string
          classification?: string | null
          created_at?: string
          error?: string | null
          forwarding_confirm_url?: string | null
          from_address?: string | null
          from_domain?: string | null
          from_name?: string | null
          html_body?: string | null
          id?: string
          message_id?: string | null
          processing_status?: string
          provider_email_id?: string | null
          received_at?: string
          sent_at?: string | null
          subject?: string | null
          text_body?: string | null
          user_id: string
        }
        Update: {
          body_envelope?: Json | null
          body_state?: string
          classification?: string | null
          created_at?: string
          error?: string | null
          forwarding_confirm_url?: string | null
          from_address?: string | null
          from_domain?: string | null
          from_name?: string | null
          html_body?: string | null
          id?: string
          message_id?: string | null
          processing_status?: string
          provider_email_id?: string | null
          received_at?: string
          sent_at?: string | null
          subject?: string | null
          text_body?: string | null
          user_id?: string
        }
        Relationships: []
      }
      extractions: {
        Row: {
          confidence: number | null
          created_at: string
          email_id: string
          id: string
          model: string
          parcel_id: string | null
          result: Json
          user_id: string
        }
        Insert: {
          confidence?: number | null
          created_at?: string
          email_id: string
          id?: string
          model: string
          parcel_id?: string | null
          result: Json
          user_id: string
        }
        Update: {
          confidence?: number | null
          created_at?: string
          email_id?: string
          id?: string
          model?: string
          parcel_id?: string | null
          result?: Json
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "extractions_email_id_fkey"
            columns: ["email_id"]
            isOneToOne: false
            referencedRelation: "emails"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "extractions_parcel_id_fkey"
            columns: ["parcel_id"]
            isOneToOne: false
            referencedRelation: "parcels"
            referencedColumns: ["id"]
          },
        ]
      }
      inbox_addresses: {
        Row: {
          created_at: string
          id: string
          local_part: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          local_part: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          local_part?: string
          user_id?: string
        }
        Relationships: []
      }
      login_mail_sends: {
        Row: {
          email_hash: string
          id: number
          ip_hash: string | null
          sent_at: string
        }
        Insert: {
          email_hash: string
          id?: never
          ip_hash?: string | null
          sent_at?: string
        }
        Update: {
          email_hash?: string
          id?: never
          ip_hash?: string | null
          sent_at?: string
        }
        Relationships: []
      }
      parcel_items: {
        Row: {
          created_at: string
          evidence: string | null
          id: string
          name: string
          parcel_id: string
          quantity: number | null
          unit_price: number | null
          user_id: string
        }
        Insert: {
          created_at?: string
          evidence?: string | null
          id?: string
          name: string
          parcel_id: string
          quantity?: number | null
          unit_price?: number | null
          user_id: string
        }
        Update: {
          created_at?: string
          evidence?: string | null
          id?: string
          name?: string
          parcel_id?: string
          quantity?: number | null
          unit_price?: number | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "parcel_items_parcel_id_fkey"
            columns: ["parcel_id"]
            isOneToOne: false
            referencedRelation: "parcels"
            referencedColumns: ["id"]
          },
        ]
      }
      parcels: {
        Row: {
          carrier: string | null
          category: string | null
          category_source: string | null
          created_at: string
          expected_date: string | null
          expected_date_end: string | null
          expected_text: string | null
          expected_window_end: string | null
          expected_window_start: string | null
          id: string
          last_email_at: string | null
          needs_review: boolean
          order_number: string | null
          ordered_at: string | null
          presence_evidence: string | null
          requires_presence: boolean | null
          shop: string
          shop_key: string | null
          source: string
          status: string
          title: string | null
          total_amount: number | null
          tracking_number: string | null
          tracking_url: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          carrier?: string | null
          category?: string | null
          category_source?: string | null
          created_at?: string
          expected_date?: string | null
          expected_date_end?: string | null
          expected_text?: string | null
          expected_window_end?: string | null
          expected_window_start?: string | null
          id?: string
          last_email_at?: string | null
          needs_review?: boolean
          order_number?: string | null
          ordered_at?: string | null
          presence_evidence?: string | null
          requires_presence?: boolean | null
          shop: string
          shop_key?: string | null
          source?: string
          status?: string
          title?: string | null
          total_amount?: number | null
          tracking_number?: string | null
          tracking_url?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          carrier?: string | null
          category?: string | null
          category_source?: string | null
          created_at?: string
          expected_date?: string | null
          expected_date_end?: string | null
          expected_text?: string | null
          expected_window_end?: string | null
          expected_window_start?: string | null
          id?: string
          last_email_at?: string | null
          needs_review?: boolean
          order_number?: string | null
          ordered_at?: string | null
          presence_evidence?: string | null
          requires_presence?: boolean | null
          shop?: string
          shop_key?: string | null
          source?: string
          status?: string
          title?: string | null
          total_amount?: number | null
          tracking_number?: string | null
          tracking_url?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      screen_events: {
        Row: {
          created_at: string
          decision: string
          flagged_at: string | null
          from_domain: string | null
          id: string
          reason: string | null
          subject: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          decision: string
          flagged_at?: string | null
          from_domain?: string | null
          id?: string
          reason?: string | null
          subject?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          decision?: string
          flagged_at?: string | null
          from_domain?: string | null
          id?: string
          reason?: string | null
          subject?: string | null
          user_id?: string
        }
        Relationships: []
      }
      user_keys: {
        Row: {
          activated_at: string | null
          challenge_hash: string
          created_at: string
          kdf_iterations: number
          kdf_salt: string
          key_id: string
          public_key: string
          retired_at: string | null
          user_id: string
          wrap_iv: string
          wrapped_private_key: string
        }
        Insert: {
          activated_at?: string | null
          challenge_hash: string
          created_at?: string
          kdf_iterations: number
          kdf_salt: string
          key_id: string
          public_key: string
          retired_at?: string | null
          user_id: string
          wrap_iv: string
          wrapped_private_key: string
        }
        Update: {
          activated_at?: string | null
          challenge_hash?: string
          created_at?: string
          kdf_iterations?: number
          kdf_salt?: string
          key_id?: string
          public_key?: string
          retired_at?: string | null
          user_id?: string
          wrap_iv?: string
          wrapped_private_key?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      activate_user_key: {
        Args: { p_challenge_hash: string; p_key_id: string; p_user_id: string }
        Returns: string
      }
      activate_user_key_checked: {
        Args: {
          p_challenge_hash: string
          p_expected_current_key_id: string | null
          p_key_id: string
          p_user_id: string
        }
        Returns: string
      }
      claim_claude_call: {
        Args: {
          p_global_limit: number
          p_user_id: string
          p_user_limit: number
        }
        Returns: string
      }
      claim_claude_call_v2: {
        Args: {
          p_global_limit: number
          p_user_id: string
          p_user_limit: number
        }
        Returns: {
          claim_id: number
          verdict: string
        }[]
      }
      claim_login_mail: {
        Args: {
          p_email_10m_limit: number
          p_email_1h_limit: number
          p_email_hash: string
          p_ip_1h_limit: number
          p_ip_hash: string
        }
        Returns: {
          claim_id: number
          verdict: string
        }[]
      }
      release_claude_call: {
        Args: { p_claim_id: number; p_user_id: string }
        Returns: number
      }
      release_login_mail: {
        Args: { p_claim_id: number; p_email_hash: string }
        Returns: number
      }
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
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
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const
