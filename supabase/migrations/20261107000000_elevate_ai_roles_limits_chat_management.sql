-- Elevate AI: roles institucionales, límites diarios, historial y soporte docente.
-- Ejecutar DESPUÉS de las migraciones anteriores de Elevate AI y classroom.sql.

BEGIN;

-- Clasificación institucional y excepción temporal para pruebas internas.
CREATE OR REPLACE FUNCTION public.elevate_is_teacher_email(p_email text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $function_body$
  SELECT
    pg_catalog.lower(pg_catalog.btrim(COALESCE(p_email, ''))) = 'josezuritae13@gmail.com'
    OR (
      pg_catalog.lower(pg_catalog.split_part(pg_catalog.btrim(COALESCE(p_email, '')), '@', 2)) = 'highlandsquito.edu.ec'
      AND pg_catalog.split_part(pg_catalog.btrim(COALESCE(p_email, '')), '@', 3) = ''
      AND pg_catalog.lower(pg_catalog.split_part(pg_catalog.btrim(COALESCE(p_email, '')), '@', 1)) NOT LIKE 'est.%'
    );
$function_body$;

DO $role_tests$
BEGIN
  IF NOT public.elevate_is_teacher_email('josezurita@highlandsquito.edu.ec') THEN
    RAISE EXCEPTION 'Falló la detección del correo institucional de profesor.';
  END IF;
  IF public.elevate_is_teacher_email('est.josezurita@highlandsquito.edu.ec') THEN
    RAISE EXCEPTION 'Un correo con prefijo est. no debe clasificarse como profesor.';
  END IF;
  IF NOT public.elevate_is_teacher_email('josezuritae13@gmail.com') THEN
    RAISE EXCEPTION 'Falló la excepción temporal de pruebas para el correo Gmail.';
  END IF;
  IF public.elevate_is_teacher_email('otra.cuenta@gmail.com') THEN
    RAISE EXCEPTION 'Una cuenta Gmail normal no debe clasificarse como profesor.';
  END IF;
END;
$role_tests$;

UPDATE public.profiles AS p
SET email = COALESCE(u.email, ''),
    role = CASE WHEN public.elevate_is_teacher_email(u.email) THEN 'teacher' ELSE 'student' END
FROM auth.users AS u
WHERE u.id = p.id;

-- Contador de conversaciones nuevas además del contador de mensajes.
ALTER TABLE public.ai_daily_usage
  ADD COLUMN IF NOT EXISTS conversation_count integer NOT NULL DEFAULT 0
  CHECK (conversation_count >= 0);

-- Los profesores también pueden consultar y borrar su propio historial de IA.
DROP POLICY IF EXISTS ai_conversations_teacher_read ON public.ai_conversations;
CREATE POLICY ai_conversations_teacher_read
ON public.ai_conversations FOR SELECT TO authenticated
USING (user_id = (SELECT auth.uid()) AND public.elevate_is_teacher());

DROP POLICY IF EXISTS ai_conversations_teacher_delete ON public.ai_conversations;
CREATE POLICY ai_conversations_teacher_delete
ON public.ai_conversations FOR DELETE TO authenticated
USING (user_id = (SELECT auth.uid()) AND public.elevate_is_teacher());

DROP POLICY IF EXISTS ai_messages_teacher_read ON public.ai_messages;
CREATE POLICY ai_messages_teacher_read
ON public.ai_messages FOR SELECT TO authenticated
USING (
  user_id = (SELECT auth.uid())
  AND public.elevate_is_teacher()
  AND EXISTS (
    SELECT 1 FROM public.ai_conversations AS c
    WHERE c.id = ai_messages.conversation_id AND c.user_id = (SELECT auth.uid())
  )
);

GRANT SELECT, DELETE ON TABLE public.ai_conversations TO authenticated;
GRANT SELECT ON TABLE public.ai_messages TO authenticated;

-- Consulta de cuota: los valores se calculan en servidor, nunca desde el navegador.
CREATE OR REPLACE FUNCTION public.elevate_get_ai_quota()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function_body$
DECLARE
  v_user uuid := (SELECT auth.uid());
  v_email text;
  v_role text;
  v_limit integer;
  v_conversation_limit integer;
  v_used integer := 0;
  v_conversations integer := 0;
  v_today date := (pg_catalog.now() AT TIME ZONE 'America/Guayaquil')::date;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'Inicia sesión para consultar tu límite.'; END IF;
  SELECT pg_catalog.lower(p.email), p.role INTO v_email, v_role
  FROM public.profiles AS p WHERE p.id = v_user;
  IF v_role IS NULL THEN RAISE EXCEPTION 'No se encontró tu perfil institucional.'; END IF;

  IF v_role = 'teacher' OR v_email = 'josezuritae13@gmail.com' THEN
    v_limit := 100; v_conversation_limit := 20;
  ELSIF v_email = 'est.josezurita@highlandsquito.edu.ec' THEN
    v_limit := 40; v_conversation_limit := 10;
  ELSE
    v_limit := 20; v_conversation_limit := 5;
  END IF;

  SELECT u.request_count, u.conversation_count INTO v_used, v_conversations
  FROM public.ai_daily_usage AS u WHERE u.user_id = v_user AND u.usage_date = v_today;
  v_used := COALESCE(v_used, 0);
  v_conversations := COALESCE(v_conversations, 0);

  RETURN pg_catalog.jsonb_build_object(
    'role', v_role, 'used', v_used, 'limit', v_limit,
    'remaining', GREATEST(0, v_limit - v_used),
    'conversations_used', v_conversations,
    'conversations_limit', v_conversation_limit,
    'conversations_remaining', GREATEST(0, v_conversation_limit - v_conversations)
  );
END;
$function_body$;

-- Consumo atómico de cuota. Un mensaje temporal consume mensaje, pero no conversación.
CREATE OR REPLACE FUNCTION public.elevate_consume_ai_quota(p_new_conversation boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function_body$
DECLARE
  v_user uuid := (SELECT auth.uid());
  v_email text;
  v_role text;
  v_limit integer;
  v_conversation_limit integer;
  v_used integer;
  v_conversations integer;
  v_today date := (pg_catalog.now() AT TIME ZONE 'America/Guayaquil')::date;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'Inicia sesión para usar Elevate AI.'; END IF;
  SELECT pg_catalog.lower(p.email), p.role INTO v_email, v_role
  FROM public.profiles AS p WHERE p.id = v_user;
  IF v_role IS NULL THEN RAISE EXCEPTION 'No se encontró tu perfil institucional.'; END IF;

  IF v_role = 'teacher' OR v_email = 'josezuritae13@gmail.com' THEN
    v_limit := 100; v_conversation_limit := 20;
  ELSIF v_email = 'est.josezurita@highlandsquito.edu.ec' THEN
    v_limit := 40; v_conversation_limit := 10;
  ELSE
    v_limit := 20; v_conversation_limit := 5;
  END IF;

  INSERT INTO public.ai_daily_usage (user_id, usage_date, request_count, conversation_count)
  VALUES (v_user, v_today, 0, 0)
  ON CONFLICT (user_id, usage_date) DO NOTHING;

  SELECT u.request_count, u.conversation_count INTO v_used, v_conversations
  FROM public.ai_daily_usage AS u
  WHERE u.user_id = v_user AND u.usage_date = v_today
  FOR UPDATE;

  IF v_used >= v_limit OR (p_new_conversation AND v_conversations >= v_conversation_limit) THEN
    RETURN pg_catalog.jsonb_build_object(
      'allowed', false, 'role', v_role, 'used', v_used, 'limit', v_limit,
      'remaining', GREATEST(0, v_limit - v_used),
      'conversations_used', v_conversations,
      'conversations_limit', v_conversation_limit,
      'conversations_remaining', GREATEST(0, v_conversation_limit - v_conversations)
    );
  END IF;

  UPDATE public.ai_daily_usage
  SET request_count = request_count + 1,
      conversation_count = conversation_count + CASE WHEN p_new_conversation THEN 1 ELSE 0 END,
      updated_at = pg_catalog.now()
  WHERE user_id = v_user AND usage_date = v_today
  RETURNING request_count, conversation_count INTO v_used, v_conversations;

  RETURN pg_catalog.jsonb_build_object(
    'allowed', true, 'role', v_role, 'used', v_used, 'limit', v_limit,
    'remaining', GREATEST(0, v_limit - v_used),
    'conversations_used', v_conversations,
    'conversations_limit', v_conversation_limit,
    'conversations_remaining', GREATEST(0, v_conversation_limit - v_conversations)
  );
END;
$function_body$;

REVOKE ALL ON FUNCTION public.elevate_get_ai_quota() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.elevate_consume_ai_quota(boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.elevate_get_ai_quota() TO authenticated;
GRANT EXECUTE ON FUNCTION public.elevate_consume_ai_quota(boolean) TO authenticated;

COMMIT;
