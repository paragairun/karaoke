-- =============================================================================
-- Party participants: num_participants on stages, assigned_to on stage_queue
-- =============================================================================
-- stages.num_participants  — how many people will be singing (set at party creation)
-- stage_queue.assigned_to  — display name of the participant this song is queued for

ALTER TABLE public.stages
  ADD COLUMN IF NOT EXISTS num_participants smallint CHECK (num_participants IS NULL OR (num_participants >= 2 AND num_participants <= 50));

ALTER TABLE public.stage_queue
  ADD COLUMN IF NOT EXISTS assigned_to text CHECK (assigned_to IS NULL OR length(trim(assigned_to)) > 0);
