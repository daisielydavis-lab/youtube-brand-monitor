-- Campaign v4: add classification and lifecycle columns
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS cluster_type text DEFAULT 'multi_creator_campaign';
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS confirmed_count integer DEFAULT 0;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS likely_count integer DEFAULT 0;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS full_start_at text;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS full_end_at text;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS last_placement_at text;
