-- =============================================================================
-- Reports on song_attempts (run any of these in Supabase -> SQL Editor)
-- =============================================================================
-- Change the '7 days' in each query to look at another period.

-- 1. Where people drop off (last 7 days)
SELECT outcome, count(*) AS clicks,
       round(100.0 * count(*) / sum(count(*)) OVER (), 1) AS percent
FROM public.song_attempt_outcomes
WHERE created_at > now() - interval '7 days'
GROUP BY outcome
ORDER BY clicks DESC;

-- 2. Same, per day
SELECT date_trunc('day', created_at AT TIME ZONE 'Asia/Kolkata')::date AS day,
       count(*) AS clicks,
       count(*) FILTER (WHERE outcome = 'played') AS played,
       count(*) FILTER (WHERE outcome = 'separation failed') AS failed,
       count(*) FILTER (WHERE outcome IN ('left while waiting', 'closed while waiting')) AS gave_up_waiting,
       count(*) FILTER (WHERE outcome = 'sing page never opened') AS sing_page_never_opened
FROM public.song_attempt_outcomes
WHERE created_at > now() - interval '7 days'
GROUP BY 1
ORDER BY 1 DESC;

-- 3. "Is the song loading OK?" answers, against what really happened
SELECT feedback, outcome, count(*) AS clicks
FROM public.song_attempt_outcomes
WHERE created_at > now() - interval '7 days' AND feedback IS NOT NULL
GROUP BY feedback, outcome
ORDER BY feedback, clicks DESC;

-- 4. Separation errors, most common first
SELECT error, count(*) AS clicks, count(DISTINCT track_id) AS songs
FROM public.song_attempt_outcomes
WHERE created_at > now() - interval '7 days' AND error IS NOT NULL
GROUP BY error
ORDER BY clicks DESC;

-- 5. Songs that fail or make people give up
SELECT title, artist, source, count(*) AS clicks,
       count(*) FILTER (WHERE outcome = 'played') AS played,
       count(*) FILTER (WHERE outcome = 'separation failed') AS failed,
       count(*) FILTER (WHERE outcome IN ('left while waiting', 'closed while waiting')) AS gave_up
FROM public.song_attempt_outcomes
WHERE created_at > now() - interval '30 days'
GROUP BY title, artist, source
HAVING count(*) FILTER (WHERE outcome <> 'played') > 0
ORDER BY failed DESC, gave_up DESC, clicks DESC
LIMIT 50;

-- 6. How long separation takes (fresh vs already separated)
SELECT from_cache,
       count(*) AS songs,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY separation_seconds) AS median_seconds,
       percentile_cont(0.9) WITHIN GROUP (ORDER BY separation_seconds) AS p90_seconds
FROM public.song_attempt_outcomes
WHERE created_at > now() - interval '7 days' AND separation_seconds IS NOT NULL
GROUP BY from_cache;

-- 7. How long people waited before leaving
SELECT width_bucket(seconds_until_left, 0, 180, 6) AS bucket,
       min(seconds_until_left) AS from_s, max(seconds_until_left) AS to_s, count(*) AS people
FROM public.song_attempt_outcomes
WHERE created_at > now() - interval '7 days' AND outcome = 'left while waiting'
GROUP BY 1
ORDER BY 1;

-- 8. By device
SELECT device, count(*) AS clicks,
       round(100.0 * count(*) FILTER (WHERE outcome = 'played') / count(*), 1) AS played_percent
FROM public.song_attempt_outcomes
WHERE created_at > now() - interval '7 days'
GROUP BY device
ORDER BY clicks DESC;
