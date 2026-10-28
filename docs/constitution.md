# Constitución — Agente personal de empleo v2

Línea base nueva, separada de JobHunter v1 y de JOBFORCE. No se mezclan sus
numeraciones RF/T, sus datos ni sus candidaturas. Identificadores de esta
línea base: RF-V2-001…100 y T-V2-001…080.

## Principios no negociables

- Una sola persona. De 1 a 10 perfiles profesionales que comparten un único
  repositorio de hechos declarados. No se inventan historias alternativas.
- Candidaturas y su material exclusivamente en inglés. Interfaz en español.
  No hay interfaz bilingüe.
- Sin login ni registro en la aplicación, sin roles. Despliegue privado
  solamente: localhost, red privada o túnel hacia Oracle. Nada público nuevo.
- xAI es el único proveedor LLM. La clave vive solo en el backend.
- Búsqueda y solicitud son contratos separados. Una API pública de ofertas
  nunca autoriza usar los endpoints de contratación de un empleador.
- LinkedIn es búsqueda guardada, asistida manualmente, importación y
  resolución a la oferta de la empresa o del ATS. No hay rastreo completo
  prometido, ni automatización, ni evasión.
- Un solo navegador Chromium real y compartido, con propiedad de control
  explícita. La toma humana revoca las escrituras del agente. Al devolver
  la sesión, el agente vuelve a observar antes de actuar. Ver una captura
  no equivale a tomar el control.
- Una sola solicitud activa en el navegador a la vez.
- Las respuestas se resuelven por concepto y ámbito. La narrativa del LLM
  nunca se promueve a hecho personal. Un hecho ausente se pregunta una vez
  y se guarda; no se infiere.
- Antes de cualquier acción final, el intento queda persistido. Después
  del clic, el resultado se verifica con evidencia inequívoca. Un resultado
  incierto queda `unknown` y nunca se reenvía. No se promete exactly-once.
- El tablero comercial es independiente de la evidencia técnica de envío.
  Cambiar un estado en el tablero no fabrica una confirmación.
- Toda la configuración debe poder hacerse desde la interfaz, sin código.

## ATS

- Conjunto inicial a certificar: Greenhouse, Lever, Ashby.
- SmartRecruiters se evalúa en F0 y queda como candidata a extensión.
- Workday, iCIMS, Taleo, SuccessFactors y Workable son genéricos o
  asistidos hasta que se certifiquen, no certificados por defecto.

## Puertas

- Cada bloque termina en una puerta (G0…G11) con suite integrada,
  typecheck y build donde aplique. Un ATS sin piloto real no es un ATS
  certificado, aunque el código esté hecho.
