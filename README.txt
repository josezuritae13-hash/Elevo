Elevo — EXTENSIÓN PARA COPIAR ACTIVIDADES DE IDUKAY
Versión: 0.2.1

INSTALACIÓN
1. Descomprime Elevo-idukay-extension.zip.
2. Abre Google Chrome y entra en chrome://extensions.
3. Activa "Modo de desarrollador".
4. Pulsa "Cargar descomprimida".
5. Selecciona la carpeta elevo-idukay-extension.
6. Abre Idukay en Chrome e inicia sesión normalmente.
7. En la misma pestaña de Idukay, abre la extensión y pulsa "Copiar mis notas".
8. En Elevo, abre el importador y pega el JSON (Ctrl+V).

QUÉ COPIA
- Actividades de courses.activities.
- Asignatura, título, nota, fecha, descripción y observaciones.
- Actividades sin nota con score=null y status="pending".
- Actividades calificadas con status="graded".

PERÍODO CONSULTADO
Desde 365 días antes del día actual hasta 90 días después. Las consultas se
separan en bloques de 34 días para mantener rangos parecidos al que ya respondió
correctamente en la prueba de Idukay.

PRIVACIDAD Y SESIÓN
La extensión no solicita ni almacena contraseñas, cookies o tokens. La petición
se ejecuta en la pestaña de Idukay con la sesión que ya está iniciada. El JSON
se copia al portapapeles y no se envía a un servidor externo.

NOTA DE INTEGRACIÓN
El importador de Elevo debe leer un objeto con source="idukay", version=1 y
un array activities. No se incluye maxScore porque el endpoint examinado no
proporciona ese dato de forma explícita.
