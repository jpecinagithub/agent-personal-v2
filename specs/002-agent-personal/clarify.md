# Clarify — Preguntas resueltas y pendientes (F0)

## Resueltas por evidencia en F0

- ¿Funciona xAI con las capacidades necesarias? Sí, con un matiz: la
  búsqueda web con citas funciona por la API Responses con la herramienta
  web_search, no por chat completions, donde live_search está en desuso
  (410) y web_search no existe (422).
- ¿Hay búsqueda útil real en fuentes declaradas? Sí: 20 boards verificados
  en vivo (12 Greenhouse, 5 Ashby, 2 Lever frescas, 1 SmartRecruiters).
- ¿Es apto el servidor? Sí: Oracle ARM64 con la imagen Playwright
  existente; el riesgo ARM quedó superado para el spike.
- ¿Se demuestra toma y devolución de control? Sí, con limitaciones
  (ver risks.md): sin fotograma VNC capturado y con desconexión simulada
  por bandera de estado.
- ¿Está probado el contrato de envío seguro? Sí, con contador externo
  local: un solo envío ante reinicio y concurrencia, unknown conservado.

## Pendientes que NO bloquean F1, pero condicionan la certificación

- Detección real de caída de red en la sesión compartida
  (heartbeat/timeout del servidor de control). Queda para F6.
- Captura visual real de noVNC con una sesión humana. Queda para F6.
- Evidencia inequívoca de envío por ATS (página de confirmación,
  identificador de solicitud o equivalente). Queda para F8/F9; si un ATS
  no la ofrece, sus envíos quedan en unknown.
- Cobertura española: ningún board verificado es de empresa española.
  Queda para F3/F11; no se promete sin verificar boards españoles.
- Refresco fresco de Spotify/Lever: resuelto en T006 (board fresca
  2026-10-27), pero el recuento de T004 ya alcanzaba 20 sin ella.
- SDK definitivo de xAI (OpenAI-compatible o SDK xAI) y límites de
  búsqueda web. Queda para F1 (T-V2-014).

## Decisiones que debe tomar el usuario en G0

- Aprobar el GO limitado con el alcance recortado de validation.md, o
  renegociar el alcance (Workday certificado, automatización LinkedIn,
  cobertura española garantizada) antes de financiar F1…F11.
- Aprobar el techo de horas y la reserva de contingencia de estimates.md.
- Crear el repositorio GitHub para este expediente y confirmar el equipo
  o ámbito, ya que la importación y la creación de repos son pasos del
  usuario en este proyecto.
