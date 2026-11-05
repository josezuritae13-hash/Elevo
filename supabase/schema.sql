-- =====================================================================
-- ELEVATE - ESQUEMA PRINCIPAL
-- Supabase / PostgreSQL
--
-- Ejecutar PRIMERO, antes de classroom.sql.
-- Este archivo es idempotente en las tablas y migraciones incluidas:
-- se puede volver a ejecutar sin borrar filas.
--
-- Incluye: perfiles, materias, evaluaciones, metas, acciones, índices,
-- RLS y permisos para el cliente autenticado.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. PERFILES
-- Mantiene la clave original `id` para no romper el schema existente.
-- `email` y `role` preparan la tabla para el módulo classroom.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.profiles (
  id          uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  full_name   text,
  course      text,
  email       text NOT NULL DEFAULT '',
  role        text NOT NULL DEFAULT 'student',
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Migración segura para instalaciones anteriores de Elevate.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS full_name text,
  ADD COLUMN IF NOT EXISTS course text,
  ADD COLUMN IF NOT EXISTS email text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'student';

-- Sincroniza los correos existentes y normaliza roles nulos/incorrectos.
UPDATE public.profiles AS p
SET email = COALESCE(u.email, p.email, '')
FROM auth.users AS u
WHERE u.id = p.id;

UPDATE public.profiles
SET email = ''
WHERE email IS NULL;

UPDATE public.profiles
SET role = 'student'
WHERE role IS NULL OR role NOT IN ('student', 'teacher');

ALTER TABLE public.profiles
  ALTER COLUMN email SET DEFAULT '',
  ALTER COLUMN email SET NOT NULL,
  ALTER COLUMN role SET DEFAULT 'student',
  ALTER COLUMN role SET NOT NULL;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.profiles'::regclass
      AND conname = 'profiles_role_check'
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_role_check
      CHECK (role IN ('student', 'teacher'));
  END IF;
END;
$migration$;

-- En el schema base, todas las cuentas empiezan como estudiante.
-- classroom.sql reemplaza esta función con la regla de cuentas docentes.
-- El bloque evita sobrescribir esa regla cuando schema.sql se vuelva a correr.
DO $migration$
BEGIN
  IF pg_catalog.to_regprocedure('public.elevate_is_teacher_email(text)') IS NULL THEN
    EXECUTE $create_function$
      CREATE FUNCTION public.elevate_is_teacher_email(p_email text)
      RETURNS boolean
      LANGUAGE sql
      IMMUTABLE
      SET search_path = ''
      AS $function_body$
        SELECT false;
      $function_body$;
    $create_function$;
  END IF;
END;
$migration$;

-- Crea/sincroniza el perfil desde auth.users.
-- La función es SECURITY DEFINER para que el trigger pueda escribir el perfil
-- aunque el usuario todavía no tenga una sesión con permisos sobre profiles.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function_body$
DECLARE
  v_full_name text;
  v_role text;
BEGIN
  v_full_name := COALESCE(
    NULLIF(pg_catalog.btrim(NEW.raw_user_meta_data ->> 'full_name'), ''),
    NULLIF(pg_catalog.btrim(NEW.raw_user_meta_data ->> 'name'), ''),
    NULLIF(NEW.email, '')
  );

  v_role := CASE
    WHEN NEW.email_confirmed_at IS NOT NULL
      AND public.elevate_is_teacher_email(NEW.email) THEN 'teacher'
    ELSE 'student'
  END;

  INSERT INTO public.profiles (id, full_name, email, role)
  VALUES (NEW.id, v_full_name, COALESCE(NEW.email, ''), v_role)
  ON CONFLICT (id) DO UPDATE
  SET email = EXCLUDED.email,
      role = EXCLUDED.role,
      full_name = COALESCE(
        NULLIF(pg_catalog.btrim(NEW.raw_user_meta_data ->> 'full_name'), ''),
        NULLIF(pg_catalog.btrim(NEW.raw_user_meta_data ->> 'name'), ''),
        public.profiles.full_name,
        EXCLUDED.full_name
      );

  RETURN NEW;
END;
$function_body$;

-- Elimina triggers de las versiones anteriores para evitar dos sincronizadores.
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
DROP TRIGGER IF EXISTS elevate_profile_after_auth_change ON auth.users;

CREATE TRIGGER on_auth_user_created
AFTER INSERT OR UPDATE ON auth.users
FOR EACH ROW
EXECUTE FUNCTION public.handle_new_user();

-- Completa perfiles de usuarios ya existentes. No borra curso ni otros datos.
INSERT INTO public.profiles (id, full_name, email, role)
SELECT
  u.id,
  COALESCE(
    NULLIF(pg_catalog.btrim(u.raw_user_meta_data ->> 'full_name'), ''),
    NULLIF(pg_catalog.btrim(u.raw_user_meta_data ->> 'name'), ''),
    NULLIF(u.email, '')
  ),
  COALESCE(u.email, ''),
  CASE
    WHEN u.email_confirmed_at IS NOT NULL
      AND public.elevate_is_teacher_email(u.email) THEN 'teacher'
    ELSE 'student'
  END
FROM auth.users AS u
ON CONFLICT (id) DO UPDATE
SET email = EXCLUDED.email,
    role = EXCLUDED.role,
    full_name = COALESCE(
      NULLIF(public.profiles.full_name, ''),
      EXCLUDED.full_name
    );

-- ---------------------------------------------------------------------
-- 2. MATERIAS
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.subjects (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL DEFAULT auth.uid()
                    REFERENCES auth.users (id) ON DELETE CASCADE,
  name              text NOT NULL CHECK (char_length(trim(name)) > 0),
  color             text NOT NULL DEFAULT '#4F46E5',
  period            text,
  scale_max         numeric NOT NULL DEFAULT 10 CHECK (scale_max > 0),
  category_weights  jsonb,
  created_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.subjects
  ADD COLUMN IF NOT EXISTS category_weights jsonb;

-- ---------------------------------------------------------------------
-- 3. EVALUACIONES / CALIFICACIONES
-- score = NULL significa pendiente, no una nota de cero.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.assessments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL DEFAULT auth.uid()
              REFERENCES auth.users (id) ON DELETE CASCADE,
  subject_id  uuid NOT NULL REFERENCES public.subjects (id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (char_length(trim(name)) > 0),
  type        text NOT NULL DEFAULT 'examen',
  score       numeric,
  max_score   numeric NOT NULL DEFAULT 10 CHECK (max_score > 0),
  weight      numeric CHECK (weight IS NULL OR (weight >= 0 AND weight <= 100)),
  term        smallint NOT NULL DEFAULT 1 CHECK (term IN (1, 2, 3)),
  date        date,
  comment     text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT score_within_range
    CHECK (score IS NULL OR (score >= 0 AND score <= max_score))
);

ALTER TABLE public.assessments
  ADD COLUMN IF NOT EXISTS term smallint NOT NULL DEFAULT 1;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.assessments'::regclass
      AND conname = 'assessments_term_check'
  ) THEN
    ALTER TABLE public.assessments
      ADD CONSTRAINT assessments_term_check
      CHECK (term IN (1, 2, 3));
  END IF;
END;
$migration$;

-- ---------------------------------------------------------------------
-- 4. METAS
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.goals (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL DEFAULT auth.uid()
               REFERENCES auth.users (id) ON DELETE CASCADE,
  subject_id   uuid REFERENCES public.subjects (id) ON DELETE SET NULL,
  title        text NOT NULL CHECK (char_length(trim(title)) > 0),
  description  text,
  start_value  numeric,
  target_value numeric,
  deadline     date,
  status       text NOT NULL DEFAULT 'active'
               CHECK (status IN ('active', 'paused', 'completed', 'cancelled')),
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- 5. ACCIONES DEL PLAN DE MEJORA
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.actions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL DEFAULT auth.uid()
               REFERENCES auth.users (id) ON DELETE CASCADE,
  goal_id      uuid NOT NULL REFERENCES public.goals (id) ON DELETE CASCADE,
  description  text NOT NULL CHECK (char_length(trim(description)) > 0),
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done')),
  due_date     date,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- 6. ÍNDICES
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_subjects_user
  ON public.subjects (user_id);
CREATE INDEX IF NOT EXISTS idx_assessments_user
  ON public.assessments (user_id);
CREATE INDEX IF NOT EXISTS idx_assessments_subj
  ON public.assessments (subject_id);
CREATE INDEX IF NOT EXISTS idx_goals_user
  ON public.goals (user_id);
CREATE INDEX IF NOT EXISTS idx_goals_subject
  ON public.goals (subject_id);
CREATE INDEX IF NOT EXISTS idx_actions_user
  ON public.actions (user_id);
CREATE INDEX IF NOT EXISTS idx_actions_goal
  ON public.actions (goal_id);

-- ---------------------------------------------------------------------
-- 7. SEGURIDAD: ROW LEVEL SECURITY
-- ---------------------------------------------------------------------
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subjects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.goals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.actions ENABLE ROW LEVEL SECURITY;

-- Perfiles: cada usuario puede leer y editar únicamente sus datos básicos.
-- email y role quedan protegidos; no se permite que el cliente se autoasigne
-- el rol teacher. El perfil se crea mediante el trigger de auth.users.
DROP POLICY IF EXISTS profiles_select_own ON public.profiles;
DROP POLICY IF EXISTS profiles_insert_own ON public.profiles;
DROP POLICY IF EXISTS profiles_update_own ON public.profiles;
DROP POLICY IF EXISTS "profiles_select_own" ON public.profiles;
DROP POLICY IF EXISTS "profiles_insert_own" ON public.profiles;
DROP POLICY IF EXISTS "profiles_update_own" ON public.profiles;

CREATE POLICY profiles_select_own
ON public.profiles
FOR SELECT TO authenticated
USING (id = (SELECT auth.uid()));

CREATE POLICY profiles_update_own
ON public.profiles
FOR UPDATE TO authenticated
USING (id = (SELECT auth.uid()))
WITH CHECK (id = (SELECT auth.uid()));

-- Materias.
DROP POLICY IF EXISTS subjects_own ON public.subjects;
CREATE POLICY subjects_own
ON public.subjects
FOR ALL TO authenticated
USING (user_id = (SELECT auth.uid()))
WITH CHECK (user_id = (SELECT auth.uid()));

-- Evaluaciones: además exige que la materia pertenezca al mismo usuario.
DROP POLICY IF EXISTS assessments_own ON public.assessments;
CREATE POLICY assessments_own
ON public.assessments
FOR ALL TO authenticated
USING (user_id = (SELECT auth.uid()))
WITH CHECK (
  user_id = (SELECT auth.uid())
  AND EXISTS (
    SELECT 1
    FROM public.subjects AS s
    WHERE s.id = assessments.subject_id
      AND s.user_id = (SELECT auth.uid())
  )
);

-- Metas: si tienen materia asociada, debe ser del mismo usuario.
DROP POLICY IF EXISTS goals_own ON public.goals;
CREATE POLICY goals_own
ON public.goals
FOR ALL TO authenticated
USING (user_id = (SELECT auth.uid()))
WITH CHECK (
  user_id = (SELECT auth.uid())
  AND (
    subject_id IS NULL
    OR EXISTS (
      SELECT 1
      FROM public.subjects AS s
      WHERE s.id = goals.subject_id
        AND s.user_id = (SELECT auth.uid())
    )
  )
);

-- Acciones: la meta asociada debe pertenecer al mismo usuario.
DROP POLICY IF EXISTS actions_own ON public.actions;
CREATE POLICY actions_own
ON public.actions
FOR ALL TO authenticated
USING (user_id = (SELECT auth.uid()))
WITH CHECK (
  user_id = (SELECT auth.uid())
  AND EXISTS (
    SELECT 1
    FROM public.goals AS g
    WHERE g.id = actions.goal_id
      AND g.user_id = (SELECT auth.uid())
  )
);

-- ---------------------------------------------------------------------
-- 8. MIGRACIÓN DE CATEGORÍA: aporte -> formativa
-- Conserva las demás claves de category_weights, si existen.
-- ---------------------------------------------------------------------
UPDATE public.assessments
SET type = 'formativa'
WHERE type = 'aporte';

UPDATE public.subjects
SET category_weights =
  (category_weights - 'aporte') ||
  jsonb_build_object('formativa', category_weights -> 'aporte')
WHERE category_weights -> 'aporte' IS NOT NULL;

-- ---------------------------------------------------------------------
-- 9. PERMISOS
-- profiles: el cliente solo puede leer y editar full_name/course.
-- Los demás campos de perfil solo los gestiona el backend/trigger.
-- ---------------------------------------------------------------------
REVOKE ALL ON TABLE public.profiles FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.profiles TO authenticated;
GRANT UPDATE (full_name, course) ON TABLE public.profiles TO authenticated;

REVOKE ALL ON TABLE
  public.subjects,
  public.assessments,
  public.goals,
  public.actions
FROM PUBLIC, anon;

GRANT SELECT, INSERT, UPDATE, DELETE
ON TABLE public.subjects, public.assessments, public.goals, public.actions
TO authenticated;

-- El trigger es el único camino para crear/sincronizar perfiles.
REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.elevate_is_teacher_email(text) FROM PUBLIC, anon, authenticated;

COMMIT;

-- =====================================================================
-- FIN DE schema.sql
-- Después de ejecutarlo, ejecutar classroom.sql.
-- =====================================================================
