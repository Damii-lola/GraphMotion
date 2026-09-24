-- Run ONCE in the Supabase SQL editor. Stores every generated ad so /preview/<job-id> survives Render restarts.
-- The ad's images live in the existing storage bucket (SUPABASE_STORAGE_BUCKET, default "rendered-videos") under previews/<job-id>/.
create table if not exists public.site_previews (
  job_id     text primary key,              -- the numeric job id (a string of digits)
  company    text,
  status     text not null default 'ready', -- ready | done | error
  spec       jsonb,                         -- the AI-written ad script (the page is rebuilt from it)
  video_url  text,                          -- public URL of the rendered video once it exists
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.site_previews enable row level security;   -- only the backend's service-role key reads/writes it
