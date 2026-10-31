# Elevate

**Elevate** es una aplicación web de seguimiento académico. Permite registrar materias y calificaciones, consultar promedios, crear metas con acciones de mejora, calcular notas necesarias y transferir actividades desde Idukay mediante una extensión de Chrome.

## Funcionalidades incluidas

- Registro e inicio de sesión con Supabase Auth.
- Materias con escala de 10, 20 o 100 puntos.
- Cálculo de promedios simples, ponderados y por categorías (formativa 70% + sumativa 30%).
- Evaluaciones calificadas o pendientes, organizadas por trimestre.
- Panel con promedios, materias que requieren atención, próximas evaluaciones y gráficos.
- Metas académicas con seguimiento y acciones personalizadas.
- Calculadora de notas necesarias.
- Importación de actividades desde JSON generado por la extensión Elevate · Idukay.
- Interfaz adaptable a móviles, tabletas y escritorio, con tema oscuro y claro.

## Ejecutar localmente

1. Descarga y descomprime el proyecto.
2. Abre la carpeta `Elevate` en Visual Studio Code.
3. Inicia un servidor estático local (por ejemplo, la extensión **Live Server**).
4. Abre la URL local que te entregue el servidor.

También puedes publicar directamente el proyecto en Netlify, ya que es una aplicación estática y no necesita un proceso de compilación.

## Publicar en Netlify

En la configuración de Build settings usa:

| Campo | Valor |
|---|---|
| Branch to deploy | `main` |
| Base directory | Vacío |
| Build command | Vacío |
| Publish directory | `.` |
| Functions directory | Vacío |

El archivo principal se llama `index.html` (en minúsculas), como esperan los servidores estáticos.

## Supabase

La aplicación mantiene el proyecto Supabase configurado en `app.js`. La clave `sb_publishable_...` es una clave pública de cliente; no es una contraseña de administrador. **Nunca coloques una `service_role` key ni secretos privados en el navegador o en GitHub.**

La aplicación espera estas tablas y campos (además de los identificadores y marcas de tiempo que ya tenga tu base de datos):

- `subjects`: `name`, `period`, `scale_max`, `color`, `category_weights`, `created_at`.
- `assessments`: `subject_id`, `name`, `type`, `score`, `max_score`, `term`, `weight`, `date`, `comment`.
- `goals`: `subject_id`, `title`, `start_value`, `target_value`, `deadline`, `status`, `created_at`.
- `actions`: `goal_id`, `description`, `due_date`, `status`, `created_at`.

La app consulta las tablas con el usuario autenticado. Antes de usarla con datos reales, revisa en Supabase que **Row Level Security (RLS)** esté activado y que existan políticas que limiten lectura, creación, edición y eliminación a los registros del usuario correspondiente. La columna que identifica al propietario depende de cómo esté creada tu base de datos; no la cambies a ciegas. Comprueba también que la relación entre materias y evaluaciones y entre metas y acciones tenga el comportamiento de eliminación que deseas.

No compartas capturas con claves privadas, tokens de sesión ni contraseñas.

## Extensión de Chrome para Idukay

La extensión está en `elevate-idukay-extension/`.

1. Abre `chrome://extensions` en Chrome.
2. Activa **Modo de desarrollador**.
3. Pulsa **Cargar descomprimida**.
4. Selecciona la carpeta `elevate-idukay-extension` de este proyecto.
5. Abre Idukay e inicia sesión normalmente.
6. Recarga la pestaña de Idukay después de instalar la extensión.
7. Abre el icono de Elevate y pulsa **Copiar mis notas**.
8. En Elevate, entra en **Importar de Idukay**, pega el JSON, revisa la vista previa y confirma la importación.

La extensión consulta Idukay únicamente al pulsar uno de sus botones. No almacena la contraseña del usuario. Actualmente envía el encabezado de compatibilidad `clientversion: 12.0.3`; Idukay puede modificar su API, sus permisos o su versión requerida, por lo que la importación debe probarse con una sesión activa.

## Estructura

```text
Elevate/
├── index.html
├── favicon.svg
├── app.js
├── style.css
├── netlify.toml
├── _headers
├── README.md
└── elevate-idukay-extension/
    ├── manifest.json
    ├── icons/
    ├── popup.html
    ├── popup.css
    ├── popup.js
    └── README.txt
```

## Notas importantes

- Los datos académicos se guardan en Supabase y la aplicación necesita conexión a internet.
- Supabase JS y Chart.js se cargan desde CDN.
- Los promedios por categorías sin todas las categorías calificadas son provisionales, igual que en la lógica anterior.
- La importación muestra una vista previa antes de escribir datos. Revisa siempre las materias, fechas, trimestres y tipos detectados.
- La extensión utiliza una versión de compatibilidad de Idukay que podría dejar de funcionar si el proveedor cambia su API.
