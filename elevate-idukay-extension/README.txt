ELEVATE · IDUKAY — EXTENSIÓN DE CHROME
======================================

INSTALACIÓN
1. Abre Google Chrome y visita chrome://extensions.
2. Activa el «Modo de desarrollador».
3. Pulsa «Cargar descomprimida».
4. Selecciona esta carpeta: elevate-idukay-extension.
5. Abre Idukay e inicia sesión normalmente.
6. Recarga la pestaña de Idukay después de instalar la extensión.

USO
1. Con Idukay abierto en la pestaña activa, pulsa el icono de Elevate.
2. Pulsa «Copiar mis notas».
3. Espera a que la extensión consulte los períodos disponibles y copie el JSON.
4. Abre Elevate > Importar de Idukay.
5. Pega el JSON en el campo de importación.
6. Revisa asignaturas, actividades, fechas, trimestres y tipos.
7. Confirma la importación cuando los datos sean correctos.

DIAGNÓSTICO
El botón «Probar conexión con Idukay» consulta un rango de fechas y copia un resumen técnico.

Si aparece HTTP 403 o not_logged_in:
- Confirma que la sesión de Idukay siga activa.
- Recarga Idukay y vuelve a abrir la extensión.
- Comprueba que la página activa pertenezca a idukay.net/colegios.
- Vuelve a intentar la consulta.

La extensión utiliza el encabezado clientversion: 12.0.3. Si Idukay cambia su API o la versión requerida, puede ser necesario actualizarla.

PRIVACIDAD
La extensión consulta Idukay solo cuando el usuario pulsa uno de sus botones. No guarda la contraseña, no lee ni exporta cookies y no envía las calificaciones a un servidor externo. El JSON se copia al portapapeles del usuario para que este lo pegue manualmente en Elevate.

PERMISOS
- activeTab: actuar sobre la pestaña que el usuario tiene activa al pulsar la extensión.
- scripting: ejecutar la consulta dentro de la página abierta de Idukay.
- clipboardWrite: copiar el JSON o el diagnóstico al portapapeles.
