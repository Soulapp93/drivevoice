export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export interface Database {
  public: {
    Tables: {
      organizations: {
        Row: {
          id: string;
          name: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          name?: string;
          created_at?: string;
        };
      };
      organization_members: {
        Row: {
          organization_id: string;
          user_id: string;
          role: 'owner' | 'admin' | 'member';
          created_at: string;
        };
        Insert: {
          organization_id: string;
          user_id: string;
          role?: 'owner' | 'admin' | 'member';
          created_at?: string;
        };
        Update: {
          organization_id?: string;
          user_id?: string;
          role?: 'owner' | 'admin' | 'member';
          created_at?: string;
        };
      };
      master_brands: {
        Row: {
          id: string;
          name: string;
          short: string;
          color: string;
          soft: string;
          status: 'Publié' | 'Brouillon' | 'Archivé';
          version: number;
          updated_at: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          short: string;
          color?: string;
          soft?: string;
          status?: 'Publié' | 'Brouillon' | 'Archivé';
          version?: number;
          updated_at?: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          name?: string;
          short?: string;
          color?: string;
          soft?: string;
          status?: 'Publié' | 'Brouillon' | 'Archivé';
          version?: number;
          updated_at?: string;
          created_at?: string;
        };
      };
      master_products: {
        Row: {
          id: string;
          master_brand_id: string;
          product_id: string;
          name: string;
          detail: string;
          category: string;
          subcategory: string | null;
          price: number;
          pos_code: string | null;
          emoji: string;
          image_url: string | null;
          available: boolean;
          product_type: string;
          variants: Json;
          option_groups: Json;
          ingredients: Json;
          ingredient_settings: Json;
          modifiers: Json;
          slug: string | null;
          meat_filter: string | null;
          badges: Json;
          display_order: number;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          master_brand_id: string;
          product_id: string;
          name: string;
          detail?: string;
          category: string;
          subcategory?: string | null;
          price?: number;
          pos_code?: string | null;
          emoji?: string;
          image_url?: string | null;
          available?: boolean;
          product_type?: string;
          variants?: Json;
          option_groups?: Json;
          ingredients?: Json;
          ingredient_settings?: Json;
          modifiers?: Json;
          slug?: string | null;
          meat_filter?: string | null;
          badges?: Json;
          display_order?: number;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          master_brand_id?: string;
          product_id?: string;
          name?: string;
          detail?: string;
          category?: string;
          subcategory?: string | null;
          price?: number;
          pos_code?: string | null;
          emoji?: string;
          image_url?: string | null;
          available?: boolean;
          product_type?: string;
          variants?: Json;
          option_groups?: Json;
          ingredients?: Json;
          ingredient_settings?: Json;
          modifiers?: Json;
          slug?: string | null;
          meat_filter?: string | null;
          badges?: Json;
          display_order?: number;
          created_at?: string;
          updated_at?: string;
        };
      };
      restaurants: {
        Row: {
          id: string;
          organization_id: string;
          master_brand_id: string | null;
          name: string;
          brand: string;
          code: string | null;
          timezone: string;
          active: boolean;
          created_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          master_brand_id?: string | null;
          name: string;
          brand: string;
          code?: string | null;
          timezone?: string;
          active?: boolean;
          created_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          master_brand_id?: string | null;
          name?: string;
          brand?: string;
          code?: string | null;
          timezone?: string;
          active?: boolean;
          created_at?: string;
        };
      };
      restaurant_members: {
        Row: {
          restaurant_id: string;
          user_id: string;
          role: 'manager' | 'editor' | 'viewer';
          created_at: string;
        };
        Insert: {
          restaurant_id: string;
          user_id: string;
          role?: 'manager' | 'editor' | 'viewer';
          created_at?: string;
        };
        Update: {
          restaurant_id?: string;
          user_id?: string;
          role?: 'manager' | 'editor' | 'viewer';
          created_at?: string;
        };
      };
      restaurant_products: {
        Row: {
          id: string;
          restaurant_id: string;
          product_id: string;
          name: string;
          detail: string;
          category: string;
          subcategory: string | null;
          price: number;
          pos_code: string | null;
          emoji: string;
          image_url: string | null;
          available: boolean;
          product_type: string;
          variants: Json;
          option_groups: Json;
          ingredients: Json;
          ingredient_settings: Json;
          modifiers: Json;
          slug: string | null;
          meat_filter: string | null;
          badges: Json;
          display_order: number;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          restaurant_id: string;
          product_id: string;
          name: string;
          detail?: string;
          category: string;
          subcategory?: string | null;
          price?: number;
          pos_code?: string | null;
          emoji?: string;
          image_url?: string | null;
          available?: boolean;
          product_type?: string;
          variants?: Json;
          option_groups?: Json;
          ingredients?: Json;
          ingredient_settings?: Json;
          modifiers?: Json;
          slug?: string | null;
          meat_filter?: string | null;
          badges?: Json;
          display_order?: number;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          restaurant_id?: string;
          product_id?: string;
          name?: string;
          detail?: string;
          category?: string;
          subcategory?: string | null;
          price?: number;
          pos_code?: string | null;
          emoji?: string;
          image_url?: string | null;
          available?: boolean;
          product_type?: string;
          variants?: Json;
          option_groups?: Json;
          ingredients?: Json;
          ingredient_settings?: Json;
          modifiers?: Json;
          slug?: string | null;
          meat_filter?: string | null;
          badges?: Json;
          display_order?: number;
          created_at?: string;
          updated_at?: string;
        };
      };
    };
    Functions: {
      clone_master_catalog: {
        Args: { target_restaurant_id: string };
        Returns: void;
      };
      is_org_member: {
        Args: { target_org: string };
        Returns: boolean;
      };
      is_restaurant_member: {
        Args: { target_restaurant: string };
        Returns: boolean;
      };
    };
  };
}
