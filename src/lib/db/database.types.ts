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
      emails: {
        Row: {
          classification: string | null
          created_at: string
          error: string | null
          from_address: string | null
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
          classification?: string | null
          created_at?: string
          error?: string | null
          from_address?: string | null
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
          classification?: string | null
          created_at?: string
          error?: string | null
          from_address?: string | null
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
          created_at: string
          expected_date: string | null
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
          created_at?: string
          expected_date?: string | null
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
          created_at?: string
          expected_date?: string | null
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
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      claim_claude_call: {
        Args: { p_global_limit: number; p_user_id: string; p_user_limit: number }
        Returns: string
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
