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
    PostgrestVersion: "14.1"
  }
  public: {
    Tables: {
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          id: string
          songs_performed: number | null
          total_score: number | null
          updated_at: string
          user_id: string
          username: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          id?: string
          songs_performed?: number | null
          total_score?: number | null
          updated_at?: string
          user_id: string
          username: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          id?: string
          songs_performed?: number | null
          total_score?: number | null
          updated_at?: string
          user_id?: string
          username?: string
        }
        Relationships: []
      }
      scores: {
        Row: {
          city: string | null
          completion_ratio: number | null
          created_at: string
          display_name: string | null
          duration_seconds: number | null
          expression_accuracy: number | null
          id: string
          noise_floor: number | null
          rating: string
          ref_active_frames: number | null
          rhythm_accuracy: number | null
          score: number
          song_artist: string | null
          song_title: string
          stage_id: string | null
          thumbnail_url: string | null
          timing_accuracy: number | null
          track_id: string
          track_language: string | null
          track_source: string | null
          user_id: string
          voiced_frames: number | null
        }
        Insert: {
          city?: string | null
          completion_ratio?: number | null
          created_at?: string
          display_name?: string | null
          duration_seconds?: number | null
          expression_accuracy?: number | null
          id?: string
          noise_floor?: number | null
          rating: string
          ref_active_frames?: number | null
          rhythm_accuracy?: number | null
          score: number
          song_artist?: string | null
          song_title: string
          stage_id?: string | null
          thumbnail_url?: string | null
          timing_accuracy?: number | null
          track_id: string
          track_language?: string | null
          track_source?: string | null
          user_id: string
          voiced_frames?: number | null
        }
        Update: {
          city?: string | null
          completion_ratio?: number | null
          created_at?: string
          display_name?: string | null
          duration_seconds?: number | null
          expression_accuracy?: number | null
          id?: string
          noise_floor?: number | null
          rating?: string
          ref_active_frames?: number | null
          rhythm_accuracy?: number | null
          score?: number
          song_artist?: string | null
          song_title?: string
          stage_id?: string | null
          thumbnail_url?: string | null
          timing_accuracy?: number | null
          track_id?: string
          track_language?: string | null
          track_source?: string | null
          user_id?: string
          voiced_frames?: number | null
        }
        Relationships: []
      }
      stages: {
        Row: {
          code: string
          created_at: string
          host_user_id: string
          id: string
          is_active: boolean
          name: string
        }
        Insert: {
          code: string
          created_at?: string
          host_user_id: string
          id?: string
          is_active?: boolean
          name: string
        }
        Update: {
          code?: string
          created_at?: string
          host_user_id?: string
          id?: string
          is_active?: boolean
          name?: string
        }
        Relationships: []
      }
      stage_queue: {
        Row: {
          album: string | null
          audio_url: string
          created_at: string
          device_id: string
          duration_seconds: number | null
          id: string
          instrumental_url: string | null
          language: string | null
          position: number
          rating: string | null
          score: number | null
          singer_name: string
          song_artist: string | null
          song_title: string
          stage_id: string
          status: string
          thumbnail_url: string | null
          track_id: string
          vocals_url: string | null
        }
        Insert: {
          album?: string | null
          audio_url: string
          created_at?: string
          device_id: string
          duration_seconds?: number | null
          id?: string
          instrumental_url?: string | null
          language?: string | null
          position?: number
          rating?: string | null
          score?: number | null
          singer_name: string
          song_artist?: string | null
          song_title: string
          stage_id: string
          status?: string
          thumbnail_url?: string | null
          track_id: string
          vocals_url?: string | null
        }
        Update: {
          album?: string | null
          audio_url?: string
          created_at?: string
          device_id?: string
          duration_seconds?: number | null
          id?: string
          instrumental_url?: string | null
          language?: string | null
          position?: number
          rating?: string | null
          score?: number | null
          singer_name?: string
          song_artist?: string | null
          song_title?: string
          stage_id?: string
          status?: string
          thumbnail_url?: string | null
          track_id?: string
          vocals_url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "stage_queue_stage_id_fkey"
            columns: ["stage_id"]
            isOneToOne: false
            referencedRelation: "stages"
            referencedColumns: ["id"]
          }
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
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
