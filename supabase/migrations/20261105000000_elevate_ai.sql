-- Elevate AI conversations, recommendations, and per-student usage limits.
-- Apply after schema.sql and classroom.sql.

BEGIN;

CREATE TABLE IF NOT EXISTS public.ai_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid()
    REFERENCES auth.users (id) ON DELETE CASCADE,
  title text NOT NULL CHECK (char_length(trim(title)) BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.ai_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL
    REFERENCES public.ai_conversations (id) ON DELETE CASCADE,
  user_id uuid NOT NULL DEFAULT auth.uid()
    REFERENCES auth.users (id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL CHECK (char_length(trim(content)) BETWEEN 1 AND 6000),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.ai_recommendations (
  user_id uuid PRIMARY KEY DEFAULT auth.uid()
    REFERENCES auth.users (id) ON DELETE CASCADE,
  context_hash text NOT NULL CHECK (char_length(context_hash) = 64),
  recommendations jsonb NOT NULL
    CHECK (jsonb_typeof(recommendations) = 'array'),
  generated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.ai_daily_usage (
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  usage_date date NOT NULL DEFAULT current_date,
  request_count integer NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, usage_date)
);

CREATE INDEX IF NOT EXISTS idx_ai_conversations_user_updated
  ON public.ai_conversations (user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_messages_conversation_created
  ON public.ai_messages (conversation_id, created_at);

ALTER TABLE public.ai_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_recommendations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_daily_usage ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_conversations_student_manage ON public.ai_conversations;
CREATE POLICY ai_conversations_student_manage
ON public.ai_conversations
FOR ALL TO authenticated
USING (
  user_id = (SELECT auth.uid())
  AND NOT public.elevate_is_teacher()
)
WITH CHECK (
  user_id = (SELECT auth.uid())
  AND NOT public.elevate_is_teacher()
);

DROP POLICY IF EXISTS ai_messages_student_read ON public.ai_messages;
CREATE POLICY ai_messages_student_read
ON public.ai_messages
FOR SELECT TO authenticated
USING (
  user_id = (SELECT auth.uid())
  AND NOT public.elevate_is_teacher()
  AND EXISTS (
    SELECT 1
    FROM public.ai_conversations AS c
    WHERE c.id = ai_messages.conversation_id
      AND c.user_id = (SELECT auth.uid())
  )
);

DROP POLICY IF EXISTS ai_messages_student_insert ON public.ai_messages;
CREATE POLICY ai_messages_student_insert
ON public.ai_messages
FOR INSERT TO authenticated
WITH CHECK (
  user_id = (SELECT auth.uid())
  AND NOT public.elevate_is_teacher()
  AND EXISTS (
    SELECT 1
    FROM public.ai_conversations AS c
    WHERE c.id = ai_messages.conversation_id
      AND c.user_id = (SELECT auth.uid())
  )
);

DROP POLICY IF EXISTS ai_recommendations_student_manage ON public.ai_recommendations;
CREATE POLICY ai_recommendations_student_manage
ON public.ai_recommendations
FOR ALL TO authenticated
USING (
  user_id = (SELECT auth.uid())
  AND NOT public.elevate_is_teacher()
)
WITH CHECK (
  user_id = (SELECT auth.uid())
  AND NOT public.elevate_is_teacher()
);

DROP POLICY IF EXISTS ai_daily_usage_no_client_access ON public.ai_daily_usage;
CREATE POLICY ai_daily_usage_no_client_access
ON public.ai_daily_usage
FOR ALL TO authenticated
USING (false)
WITH CHECK (false);

REVOKE ALL ON TABLE
  public.ai_conversations,
  public.ai_messages,
  public.ai_recommendations,
  public.ai_daily_usage
FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE
ON TABLE public.ai_conversations
TO authenticated;

GRANT SELECT, INSERT
ON TABLE public.ai_messages
TO authenticated;

GRANT SELECT, INSERT, UPDATE
ON TABLE public.ai_recommendations
TO authenticated;

CREATE OR REPLACE FUNCTION public.elevate_consume_ai_quota()
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function_body$
DECLARE
  v_request_count integer;
BEGIN
  IF (SELECT auth.uid()) IS NULL
    OR public.elevate_is_teacher()
    OR NOT EXISTS (
      SELECT 1
      FROM public.profiles AS p
      WHERE p.id = (SELECT auth.uid())
        AND p.role = 'student'
    ) THEN
    RETURN false;
  END IF;

  INSERT INTO public.ai_daily_usage (user_id, usage_date, request_count)
  VALUES (
    (SELECT auth.uid()),
    (pg_catalog.now() AT TIME ZONE 'utc')::date,
    1
  )
  ON CONFLICT (user_id, usage_date) DO UPDATE
  SET request_count = public.ai_daily_usage.request_count + 1,
      updated_at = pg_catalog.now()
  WHERE public.ai_daily_usage.request_count < 20
  RETURNING request_count INTO v_request_count;

  RETURN v_request_count IS NOT NULL;
END;
$function_body$;

REVOKE ALL ON FUNCTION public.elevate_consume_ai_quota()
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.elevate_consume_ai_quota()
TO authenticated;

COMMIT;
