-- =====================================================================
-- ELEVATE - MÓDULO CLASSROOM (PROFESORES, CLASES Y SEGUIMIENTO)
-- Supabase / PostgreSQL
--
-- Ejecutar DESPUÉS de schema.sql.
-- No elimina tablas ni datos del esquema principal.
-- Compatible con public.profiles.id (NO usa profiles.user_id).
-- Se puede volver a ejecutar sin borrar filas.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. CLASIFICACIÓN DE CUENTAS DOCENTES
--
-- Regla heredada del diseño original:
--   - Dominio: highlandsquito.edu.ec
--   - Las cuentas cuyo usuario empieza por "est" son estudiantes.
--   - Las demás cuentas de ese dominio se consideran docentes.
--
-- IMPORTANTE: esta regla depende del formato de correo del colegio.
-- Si el colegio usa otro patrón, modifica esta función antes de ejecutar.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.elevate_is_teacher_email(p_email text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $function_body$
  SELECT
    pg_catalog.lower(pg_catalog.split_part(pg_catalog.btrim(COALESCE(p_email, '')), '@', 2))
      = 'highlandsquito.edu.ec'
    AND pg_catalog.split_part(pg_catalog.btrim(COALESCE(p_email, '')), '@', 3) = ''
    AND pg_catalog.lower(pg_catalog.split_part(pg_catalog.btrim(COALESCE(p_email, '')), '@', 1))
      NOT LIKE 'est%';
$function_body$;

-- Actualiza el rol/correo de los perfiles ya registrados sin tocar full_name,
-- course ni created_at. Los roles no se editan desde el navegador.
UPDATE public.profiles AS p
SET email = COALESCE(u.email, ''),
    role = CASE
      WHEN u.email_confirmed_at IS NOT NULL
        AND public.elevate_is_teacher_email(u.email) THEN 'teacher'
      ELSE 'student'
    END
FROM auth.users AS u
WHERE u.id = p.id;

-- Elimina el trigger alternativo del archivo previo, si ya se había instalado.
-- Se conserva un solo trigger y una sola función de sincronización.
DROP TRIGGER IF EXISTS elevate_profile_after_auth_change ON auth.users;
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;

CREATE TRIGGER on_auth_user_created
AFTER INSERT OR UPDATE ON auth.users
FOR EACH ROW
EXECUTE FUNCTION public.handle_new_user();

-- ---------------------------------------------------------------------
-- 2. CLASES Y MATRÍCULAS
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.teacher_classes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id  uuid NOT NULL DEFAULT auth.uid()
              REFERENCES auth.users (id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (char_length(trim(name)) BETWEEN 1 AND 100),
  join_code   text NOT NULL UNIQUE
              DEFAULT upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12)),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.class_enrollments (
  class_id    uuid NOT NULL REFERENCES public.teacher_classes (id) ON DELETE CASCADE,
  student_id  uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  joined_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (class_id, student_id)
);

-- ---------------------------------------------------------------------
-- 3. TAREAS Y ENTREGAS
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.class_assignments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id    uuid NOT NULL REFERENCES public.teacher_classes (id) ON DELETE CASCADE,
  teacher_id  uuid NOT NULL DEFAULT auth.uid()
              REFERENCES auth.users (id) ON DELETE CASCADE,
  title       text NOT NULL CHECK (char_length(trim(title)) BETWEEN 1 AND 160),
  description text NOT NULL DEFAULT '',
  due_at      timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.assignment_submissions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id uuid NOT NULL REFERENCES public.class_assignments (id) ON DELETE CASCADE,
  student_id    uuid NOT NULL DEFAULT auth.uid()
                REFERENCES auth.users (id) ON DELETE CASCADE,
  response      text NOT NULL DEFAULT '',
  completed     boolean NOT NULL DEFAULT false,
  submitted_at  timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (assignment_id, student_id)
);

-- ---------------------------------------------------------------------
-- 4. NOTIFICACIONES, PROGRESO Y TIEMPO DE ESTUDIO
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.student_notifications (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id        uuid NOT NULL DEFAULT auth.uid()
                    REFERENCES auth.users (id) ON DELETE CASCADE,
  notification_type text NOT NULL,
  title             text NOT NULL,
  body              text NOT NULL,
  dedupe_key        text NOT NULL,
  read_at           timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (student_id, dedupe_key)
);

CREATE TABLE IF NOT EXISTS public.student_progress (
  student_id              uuid NOT NULL DEFAULT auth.uid()
                          REFERENCES auth.users (id) ON DELETE CASCADE,
  snapshot_date           date NOT NULL DEFAULT current_date,
  average_pct             numeric(5, 2),
  subjects                jsonb NOT NULL DEFAULT '[]'::jsonb,
  goals                   jsonb NOT NULL DEFAULT '[]'::jsonb,
  active_goals            integer NOT NULL DEFAULT 0 CHECK (active_goals >= 0),
  completed_assessments   integer NOT NULL DEFAULT 0 CHECK (completed_assessments >= 0),
  pending_assessments     integer NOT NULL DEFAULT 0 CHECK (pending_assessments >= 0),
  weekly_study_minutes    integer NOT NULL DEFAULT 0 CHECK (weekly_study_minutes >= 0),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (student_id, snapshot_date)
);

CREATE TABLE IF NOT EXISTS public.study_sessions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id        uuid NOT NULL DEFAULT auth.uid()
                    REFERENCES auth.users (id) ON DELETE CASCADE,
  study_date        date NOT NULL DEFAULT current_date,
  duration_minutes  integer NOT NULL CHECK (duration_minutes BETWEEN 5 AND 600),
  subject           text NOT NULL CHECK (char_length(trim(subject)) BETWEEN 1 AND 100),
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- 5. ASISTENCIA Y MENSAJES
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.class_attendance (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id          uuid NOT NULL REFERENCES public.teacher_classes (id) ON DELETE CASCADE,
  student_id        uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  attendance_date   date NOT NULL DEFAULT current_date,
  status            text NOT NULL CHECK (status IN ('present', 'absent', 'late', 'excused')),
  recorded_by       uuid NOT NULL DEFAULT auth.uid()
                    REFERENCES auth.users (id) ON DELETE CASCADE,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (class_id, student_id, attendance_date)
);

CREATE TABLE IF NOT EXISTS public.class_messages (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id  uuid NOT NULL REFERENCES public.teacher_classes (id) ON DELETE CASCADE,
  sender_id uuid NOT NULL DEFAULT auth.uid()
            REFERENCES auth.users (id) ON DELETE CASCADE,
  body      text NOT NULL CHECK (char_length(trim(body)) BETWEEN 1 AND 2000),
  sent_at   timestamptz NOT NULL DEFAULT now()
);

-- Completa defaults también en instalaciones donde estas tablas ya existían.
ALTER TABLE public.teacher_classes
  ALTER COLUMN teacher_id SET DEFAULT auth.uid(),
  ALTER COLUMN join_code SET DEFAULT upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12));
ALTER TABLE public.class_assignments
  ALTER COLUMN teacher_id SET DEFAULT auth.uid();
ALTER TABLE public.assignment_submissions
  ALTER COLUMN student_id SET DEFAULT auth.uid(),
  ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE public.student_notifications
  ALTER COLUMN student_id SET DEFAULT auth.uid();
ALTER TABLE public.student_progress
  ALTER COLUMN student_id SET DEFAULT auth.uid();
ALTER TABLE public.study_sessions
  ALTER COLUMN student_id SET DEFAULT auth.uid();
ALTER TABLE public.class_attendance
  ALTER COLUMN recorded_by SET DEFAULT auth.uid();
ALTER TABLE public.class_messages
  ALTER COLUMN sender_id SET DEFAULT auth.uid();

-- Periodo de las metas del esquema principal.
ALTER TABLE public.goals
  ADD COLUMN IF NOT EXISTS goal_period text NOT NULL DEFAULT 'term';

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.goals'::regclass
      AND conname = 'goals_goal_period_check'
  ) THEN
    ALTER TABLE public.goals
      ADD CONSTRAINT goals_goal_period_check
      CHECK (goal_period IN ('week', 'month', 'term'));
  END IF;
END;
$migration$;

-- ---------------------------------------------------------------------
-- 6. ÍNDICES
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_teacher_classes_teacher
  ON public.teacher_classes (teacher_id);
CREATE INDEX IF NOT EXISTS idx_class_enrollments_student
  ON public.class_enrollments (student_id);
CREATE INDEX IF NOT EXISTS idx_class_assignments_class_due
  ON public.class_assignments (class_id, due_at);
CREATE INDEX IF NOT EXISTS idx_assignment_submissions_student
  ON public.assignment_submissions (student_id);
CREATE INDEX IF NOT EXISTS idx_assignment_submissions_assignment
  ON public.assignment_submissions (assignment_id);
CREATE INDEX IF NOT EXISTS idx_notifications_student_created
  ON public.student_notifications (student_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_progress_student_date
  ON public.student_progress (student_id, snapshot_date DESC);
CREATE INDEX IF NOT EXISTS idx_study_sessions_student_date
  ON public.study_sessions (student_id, study_date DESC);
CREATE INDEX IF NOT EXISTS idx_attendance_student_date
  ON public.class_attendance (student_id, attendance_date DESC);
CREATE INDEX IF NOT EXISTS idx_attendance_class_date
  ON public.class_attendance (class_id, attendance_date DESC);
CREATE INDEX IF NOT EXISTS idx_class_messages_class_sent
  ON public.class_messages (class_id, sent_at DESC);

-- ---------------------------------------------------------------------
-- 7. FUNCIONES DE AUTORIZACIÓN
-- Las funciones SECURITY DEFINER consultan tablas protegidas por RLS.
-- search_path vacío y nombres completamente calificados evitan sustituciones.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.elevate_is_teacher()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function_body$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles AS p
    WHERE p.id = (SELECT auth.uid())
      AND p.role = 'teacher'
  );
$function_body$;

CREATE OR REPLACE FUNCTION public.elevate_is_class_teacher(p_class_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function_body$
  SELECT
    (SELECT auth.uid()) IS NOT NULL
    AND public.elevate_is_teacher()
    AND EXISTS (
      SELECT 1
      FROM public.teacher_classes AS c
      WHERE c.id = p_class_id
        AND c.teacher_id = (SELECT auth.uid())
    );
$function_body$;

CREATE OR REPLACE FUNCTION public.elevate_is_enrolled(p_class_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function_body$
  SELECT
    (SELECT auth.uid()) IS NOT NULL
    AND NOT public.elevate_is_teacher()
    AND EXISTS (
      SELECT 1
      FROM public.class_enrollments AS e
      WHERE e.class_id = p_class_id
        AND e.student_id = (SELECT auth.uid())
    );
$function_body$;

-- Solo el profesor propietario de la clase puede comprobar sus matrículas.
CREATE OR REPLACE FUNCTION public.elevate_is_enrollment(
  p_class_id uuid,
  p_student_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function_body$
  SELECT
    public.elevate_is_class_teacher(p_class_id)
    AND EXISTS (
      SELECT 1
      FROM public.class_enrollments AS e
      WHERE e.class_id = p_class_id
        AND e.student_id = p_student_id
    );
$function_body$;

CREATE OR REPLACE FUNCTION public.elevate_can_view_student(p_student_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function_body$
  SELECT
    public.elevate_is_teacher()
    AND EXISTS (
      SELECT 1
      FROM public.teacher_classes AS c
      JOIN public.class_enrollments AS e ON e.class_id = c.id
      WHERE c.teacher_id = (SELECT auth.uid())
        AND e.student_id = p_student_id
    );
$function_body$;

-- RPC para unirse a una clase con código. No se permite a docentes unirse
-- como estudiantes ni insertar matrículas directamente desde el cliente.
CREATE OR REPLACE FUNCTION public.elevate_join_class(p_join_code text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function_body$
DECLARE
  v_class_id uuid;
BEGIN
  IF (SELECT auth.uid()) IS NULL THEN
    RAISE EXCEPTION 'Debes iniciar sesión para unirte a una clase.';
  END IF;

  IF public.elevate_is_teacher() THEN
    RAISE EXCEPTION 'Solo las cuentas de estudiante pueden unirse a una clase.';
  END IF;

  IF p_join_code IS NULL OR pg_catalog.btrim(p_join_code) = '' THEN
    RAISE EXCEPTION 'Ingresa un código de clase.';
  END IF;

  SELECT c.id
  INTO v_class_id
  FROM public.teacher_classes AS c
  WHERE pg_catalog.upper(c.join_code) = pg_catalog.upper(pg_catalog.btrim(p_join_code));

  IF v_class_id IS NULL THEN
    RAISE EXCEPTION 'El código de clase no es válido.';
  END IF;

  INSERT INTO public.class_enrollments (class_id, student_id)
  VALUES (v_class_id, (SELECT auth.uid()))
  ON CONFLICT (class_id, student_id) DO NOTHING;

  RETURN v_class_id;
END;
$function_body$;

-- Mantiene updated_at cuando un estudiante modifica una entrega.
CREATE OR REPLACE FUNCTION public.elevate_touch_submission_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function_body$
BEGIN
  NEW.updated_at := pg_catalog.now();
  RETURN NEW;
END;
$function_body$;

DROP TRIGGER IF EXISTS assignment_submissions_touch_updated_at
ON public.assignment_submissions;

CREATE TRIGGER assignment_submissions_touch_updated_at
BEFORE UPDATE ON public.assignment_submissions
FOR EACH ROW
EXECUTE FUNCTION public.elevate_touch_submission_updated_at();

-- ---------------------------------------------------------------------
-- 8. ROW LEVEL SECURITY
-- ---------------------------------------------------------------------
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.teacher_classes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.class_enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.class_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assignment_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.student_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.student_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.study_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.class_attendance ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.class_messages ENABLE ROW LEVEL SECURITY;

-- Perfil: el usuario ve el suyo; un docente ve solo estudiantes de sus clases.
DROP POLICY IF EXISTS profiles_select_own ON public.profiles;
DROP POLICY IF EXISTS profiles_read_self_or_teacher ON public.profiles;
CREATE POLICY profiles_read_self_or_teacher
ON public.profiles
FOR SELECT TO authenticated
USING (
  id = (SELECT auth.uid())
  OR public.elevate_can_view_student(id)
);

-- Clases: el docente propietario administra; estudiantes matriculados leen.
DROP POLICY IF EXISTS classes_teacher_manage ON public.teacher_classes;
CREATE POLICY classes_teacher_manage
ON public.teacher_classes
FOR ALL TO authenticated
USING (
  teacher_id = (SELECT auth.uid())
  AND public.elevate_is_teacher()
)
WITH CHECK (
  teacher_id = (SELECT auth.uid())
  AND public.elevate_is_teacher()
);

DROP POLICY IF EXISTS classes_enrolled_read ON public.teacher_classes;
CREATE POLICY classes_enrolled_read
ON public.teacher_classes
FOR SELECT TO authenticated
USING (public.elevate_is_enrolled(id));

-- Matrículas: estudiante ve la suya; docente propietario ve las de su clase.
-- La creación se hace exclusivamente mediante elevate_join_class().
DROP POLICY IF EXISTS enrollments_read_related ON public.class_enrollments;
CREATE POLICY enrollments_read_related
ON public.class_enrollments
FOR SELECT TO authenticated
USING (
  student_id = (SELECT auth.uid())
  OR public.elevate_is_class_teacher(class_id)
);

-- Tareas: docentes propietarios gestionan; estudiantes matriculados consultan.
DROP POLICY IF EXISTS assignments_teacher_manage ON public.class_assignments;
CREATE POLICY assignments_teacher_manage
ON public.class_assignments
FOR ALL TO authenticated
USING (
  teacher_id = (SELECT auth.uid())
  AND public.elevate_is_class_teacher(class_id)
)
WITH CHECK (
  teacher_id = (SELECT auth.uid())
  AND public.elevate_is_class_teacher(class_id)
);

DROP POLICY IF EXISTS assignments_student_read ON public.class_assignments;
CREATE POLICY assignments_student_read
ON public.class_assignments
FOR SELECT TO authenticated
USING (public.elevate_is_enrolled(class_id));

-- Entregas: estudiante gestiona solo su propia entrega de una tarea de su clase;
-- el docente propietario puede leer las entregas de su clase.
DROP POLICY IF EXISTS submissions_student_manage ON public.assignment_submissions;
CREATE POLICY submissions_student_manage
ON public.assignment_submissions
FOR ALL TO authenticated
USING (
  student_id = (SELECT auth.uid())
  AND EXISTS (
    SELECT 1
    FROM public.class_assignments AS a
    WHERE a.id = assignment_submissions.assignment_id
      AND public.elevate_is_enrolled(a.class_id)
  )
)
WITH CHECK (
  student_id = (SELECT auth.uid())
  AND EXISTS (
    SELECT 1
    FROM public.class_assignments AS a
    WHERE a.id = assignment_submissions.assignment_id
      AND public.elevate_is_enrolled(a.class_id)
  )
);

DROP POLICY IF EXISTS submissions_teacher_read ON public.assignment_submissions;
CREATE POLICY submissions_teacher_read
ON public.assignment_submissions
FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.class_assignments AS a
    WHERE a.id = assignment_submissions.assignment_id
      AND public.elevate_is_class_teacher(a.class_id)
  )
);

-- Notificaciones privadas del estudiante.
DROP POLICY IF EXISTS notifications_student_manage ON public.student_notifications;
CREATE POLICY notifications_student_manage
ON public.student_notifications
FOR ALL TO authenticated
USING (
  student_id = (SELECT auth.uid())
  AND NOT public.elevate_is_teacher()
)
WITH CHECK (
  student_id = (SELECT auth.uid())
  AND NOT public.elevate_is_teacher()
);

-- Progreso: estudiante administra sus snapshots; profesor relacionado solo lee.
DROP POLICY IF EXISTS progress_student_manage ON public.student_progress;
CREATE POLICY progress_student_manage
ON public.student_progress
FOR ALL TO authenticated
USING (
  student_id = (SELECT auth.uid())
  AND NOT public.elevate_is_teacher()
)
WITH CHECK (
  student_id = (SELECT auth.uid())
  AND NOT public.elevate_is_teacher()
);

DROP POLICY IF EXISTS progress_teacher_read ON public.student_progress;
CREATE POLICY progress_teacher_read
ON public.student_progress
FOR SELECT TO authenticated
USING (public.elevate_can_view_student(student_id));

-- Tiempo de estudio: estudiante administra; docente relacionado solo lee.
DROP POLICY IF EXISTS study_sessions_student_manage ON public.study_sessions;
CREATE POLICY study_sessions_student_manage
ON public.study_sessions
FOR ALL TO authenticated
USING (
  student_id = (SELECT auth.uid())
  AND NOT public.elevate_is_teacher()
)
WITH CHECK (
  student_id = (SELECT auth.uid())
  AND NOT public.elevate_is_teacher()
);

DROP POLICY IF EXISTS study_sessions_teacher_read ON public.study_sessions;
CREATE POLICY study_sessions_teacher_read
ON public.study_sessions
FOR SELECT TO authenticated
USING (public.elevate_can_view_student(student_id));

-- Asistencia: el profesor de la clase registra; estudiante consulta la suya.
DROP POLICY IF EXISTS attendance_teacher_manage ON public.class_attendance;
CREATE POLICY attendance_teacher_manage
ON public.class_attendance
FOR ALL TO authenticated
USING (
  public.elevate_is_class_teacher(class_id)
  AND recorded_by = (SELECT auth.uid())
)
WITH CHECK (
  public.elevate_is_class_teacher(class_id)
  AND recorded_by = (SELECT auth.uid())
  AND public.elevate_is_enrollment(class_id, student_id)
);

DROP POLICY IF EXISTS attendance_student_read ON public.class_attendance;
CREATE POLICY attendance_student_read
ON public.class_attendance
FOR SELECT TO authenticated
USING (
  student_id = (SELECT auth.uid())
  AND public.elevate_is_enrolled(class_id)
);

-- Mensajes: solo miembros de la clase pueden leer o enviar.
DROP POLICY IF EXISTS messages_read_class ON public.class_messages;
CREATE POLICY messages_read_class
ON public.class_messages
FOR SELECT TO authenticated
USING (
  public.elevate_is_class_teacher(class_id)
  OR public.elevate_is_enrolled(class_id)
);

DROP POLICY IF EXISTS messages_send_to_class ON public.class_messages;
CREATE POLICY messages_send_to_class
ON public.class_messages
FOR INSERT TO authenticated
WITH CHECK (
  sender_id = (SELECT auth.uid())
  AND (
    public.elevate_is_class_teacher(class_id)
    OR public.elevate_is_enrolled(class_id)
  )
);

-- ---------------------------------------------------------------------
-- 9. PERMISOS
-- Ninguna tabla classroom queda accesible para anon/PUBLIC.
-- Matrículas: solo lectura directa; la unión se hace por RPC.
-- ---------------------------------------------------------------------
REVOKE ALL ON TABLE
  public.teacher_classes,
  public.class_enrollments,
  public.class_assignments,
  public.assignment_submissions,
  public.student_notifications,
  public.student_progress,
  public.study_sessions,
  public.class_attendance,
  public.class_messages
FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE
ON TABLE public.teacher_classes
TO authenticated;

GRANT SELECT
ON TABLE public.class_enrollments
TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE
ON TABLE public.class_assignments
TO authenticated;

GRANT SELECT, INSERT, UPDATE
ON TABLE public.assignment_submissions
TO authenticated;

GRANT SELECT, INSERT
ON TABLE public.student_notifications
TO authenticated;
GRANT UPDATE (read_at)
ON TABLE public.student_notifications
TO authenticated;

GRANT SELECT, INSERT, UPDATE
ON TABLE public.student_progress
TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE
ON TABLE public.study_sessions
TO authenticated;

GRANT SELECT, INSERT, UPDATE
ON TABLE public.class_attendance
TO authenticated;

GRANT SELECT, INSERT
ON TABLE public.class_messages
TO authenticated;

-- Cierra ejecución pública de funciones internas y abre solo las RPC necesarias.
REVOKE ALL ON FUNCTION public.elevate_is_teacher_email(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.elevate_touch_submission_updated_at() FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.elevate_is_teacher() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.elevate_is_class_teacher(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.elevate_is_enrolled(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.elevate_is_enrollment(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.elevate_can_view_student(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.elevate_join_class(text) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.elevate_is_teacher() TO authenticated;
GRANT EXECUTE ON FUNCTION public.elevate_is_class_teacher(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.elevate_is_enrolled(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.elevate_is_enrollment(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.elevate_can_view_student(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.elevate_join_class(text) TO authenticated;

COMMIT;

-- =====================================================================
-- FIN DE classroom.sql
-- =====================================================================
