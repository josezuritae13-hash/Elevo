-- Elevate AI: solo el servidor escribe mensajes, conversaciones y recomendaciones.
--
-- Problema que corrige: la política ai_messages_student_insert dejaba que el navegador
-- insertara filas con role = 'assistant', es decir, un estudiante podía fabricar
-- respuestas del asistente en su propio historial.
--
-- ORDEN DE DESPLIEGUE (importante):
--   1) Despliega primero la función nueva:  supabase functions deploy elevate-ai
--   2) Después ejecuta este script en SQL Editor.
-- Si lo ejecutas antes, la función anterior no podrá guardar mensajes hasta que despliegues la nueva.

BEGIN;

-- ---------------------------------------------------------------------
-- ai_messages: el cliente solo puede leer. Las inserciones las hace la función.
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS ai_messages_student_insert ON public.ai_messages;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.ai_messages FROM authenticated;
GRANT SELECT ON TABLE public.ai_messages TO authenticated;

-- ---------------------------------------------------------------------
-- ai_recommendations: el cliente solo puede leer (evita recomendaciones falsas en la caché).
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS ai_recommendations_student_manage ON public.ai_recommendations;
DROP POLICY IF EXISTS ai_recommendations_student_read ON public.ai_recommendations;
CREATE POLICY ai_recommendations_student_read
ON public.ai_recommendations
FOR SELECT TO authenticated
USING (
  user_id = (SELECT auth.uid())
  AND NOT public.elevate_is_teacher()
);
REVOKE INSERT, UPDATE, DELETE ON TABLE public.ai_recommendations FROM authenticated;
GRANT SELECT ON TABLE public.ai_recommendations TO authenticated;

-- ---------------------------------------------------------------------
-- ai_conversations: el cliente puede leer y borrar las suyas; la función las crea y actualiza.
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS ai_conversations_student_manage ON public.ai_conversations;
DROP POLICY IF EXISTS ai_conversations_student_read ON public.ai_conversations;
DROP POLICY IF EXISTS ai_conversations_student_delete ON public.ai_conversations;

CREATE POLICY ai_conversations_student_read
ON public.ai_conversations
FOR SELECT TO authenticated
USING (
  user_id = (SELECT auth.uid())
  AND NOT public.elevate_is_teacher()
);

CREATE POLICY ai_conversations_student_delete
ON public.ai_conversations
FOR DELETE TO authenticated
USING (
  user_id = (SELECT auth.uid())
  AND NOT public.elevate_is_teacher()
);

REVOKE INSERT, UPDATE ON TABLE public.ai_conversations FROM authenticated;
GRANT SELECT, DELETE ON TABLE public.ai_conversations TO authenticated;

-- ---------------------------------------------------------------------
-- La función (service_role) escribe en estas tablas.
-- ---------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE
ON TABLE public.ai_conversations, public.ai_messages, public.ai_recommendations
TO service_role;

COMMIT;

-- Verificación opcional: debe mostrar solo SELECT (y DELETE en ai_conversations) para "authenticated".
-- SELECT table_name, privilege_type
-- FROM information_schema.role_table_grants
-- WHERE grantee = 'authenticated' AND table_name LIKE 'ai\_%'
-- ORDER BY table_name, privilege_type;
