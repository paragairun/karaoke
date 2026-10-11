-- =============================================================================
-- song_attempts — one row per song a user picks from the search results
-- =============================================================================
-- Why: many visitors, few reach singing. Each row follows one click from the
-- search results to the end: did the Sing page open, did separation finish
-- (and how long it took, cached or fresh), did it fail (with the error), did
-- the song start playing, did the user leave while waiting, and their Yes/No
-- answer to "Is the song loading OK?" (asked after 30 s on the wait screen).
--
-- Written only by the song-attempts edge function (service role). RLS is on
-- with no policies, so the public anon key can neither read nor write rows.
-- Read them in Supabase: Table Editor -> song_attempt_outcomes (or
-- song_attempts for the raw timestamps). Ready-made reports:
-- supabase/queries/song_attempts_reports.sql
--
-- Run once: Supabase Dashboard -> SQL Editor -> paste this file -> Run.
-- Safe to run again.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.song_attempts (
  id                uuid PRIMARY KEY,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  -- who (anonymous per-browser id; user_id only when signed in)
  visitor_id        text NOT NULL,
  user_id           uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  device            text,                    -- mobile | tablet | desktop | tv

  -- what was clicked
  track_id          text NOT NULL,
  title             text,
  artist            text,
  album             text,
  source            text,                    -- saavn | gaana | youtube
  duration_seconds  integer,
  was_ready         boolean,                 -- showed the "Ready" badge
  is_alt_version    boolean,                 -- picked from "other versions"
  search_query      text,
  result_position   integer,                 -- 1 = first result row

  -- what happened (first time each step was reached)
  clicked_at        timestamptz NOT NULL DEFAULT now(),
  sing_page_at      timestamptz,
  separated_at      timestamptz,
  separation_ms     integer,                 -- click -> stems ready
  from_cache        boolean,                 -- true = song was already separated
  failed_at         timestamptz,
  failed_count      integer NOT NULL DEFAULT 0,
  error             text,                    -- latest failure message
  retry_count       integer NOT NULL DEFAULT 0,
  playing_at        timestamptz,
  left_at           timestamptz,
  left_stage        text,                    -- waiting | failed | ready | playing
  prompt_shown_at   timestamptz,
  feedback          text CHECK (feedback IN ('yes', 'no')),
  feedback_at       timestamptz
);

CREATE INDEX IF NOT EXISTS song_attempts_created_at_idx ON public.song_attempts (created_at DESC);
CREATE INDEX IF NOT EXISTS song_attempts_track_id_idx   ON public.song_attempts (track_id);

ALTER TABLE public.song_attempts ENABLE ROW LEVEL SECURITY;
-- (no policies on purpose: only the edge function's service role can access it)

-- One readable outcome per click. security_invoker keeps the table's RLS in
-- force for API callers, so the view is not readable with the anon key either.
CREATE OR REPLACE VIEW public.song_attempt_outcomes
WITH (security_invoker = true) AS
SELECT
  a.created_at,
  CASE
    WHEN a.playing_at   IS NOT NULL THEN 'played'
    WHEN a.separated_at IS NOT NULL THEN 'ready, never played'
    WHEN a.failed_at    IS NOT NULL THEN 'separation failed'
    WHEN a.left_at      IS NOT NULL THEN 'left while waiting'
    WHEN a.sing_page_at IS NOT NULL
         AND a.created_at < now() - interval '20 minutes' THEN 'closed while waiting'
    WHEN a.sing_page_at IS NOT NULL THEN 'waiting now'
    ELSE 'sing page never opened'
  END AS outcome,
  a.feedback,
  round(a.separation_ms / 1000.0, 1) AS separation_seconds,
  a.from_cache,
  a.error,
  a.failed_count,
  a.retry_count,
  a.left_stage,
  round(extract(epoch FROM (a.left_at - a.clicked_at))::numeric, 0) AS seconds_until_left,
  a.title,
  a.artist,
  a.source,
  a.duration_seconds,
  a.was_ready,
  a.search_query,
  a.result_position,
  a.device,
  (a.user_id IS NOT NULL) AS signed_in,
  a.visitor_id,
  a.track_id,
  a.id
FROM public.song_attempts a;

REVOKE ALL ON public.song_attempts FROM anon, authenticated;
REVOKE ALL ON public.song_attempt_outcomes FROM anon, authenticated;
