# ADR-001 — xAI como único LLM, modelo fijado por lista real

- Decisión: usar xAI como único proveedor LLM. Modelo fijado en F0:
  grok-4.20-non-reasoning, tras comprobar la lista real de la cuenta
  (14 modelos el 2026-10-27).
- Alternativas rechazadas: fijar un nombre de modelo por documentación
  secundaria, y usar otro proveedor como respaldo sin decisión del
  usuario. Ambas romperían la trazabilidad del pliego.
- Consecuencias: chat, salida estructurada, streaming y herramientas
  propias van por chat completions. La búsqueda web con citas va por la
  API Responses con web_search. El cambio de modelo exige comprobar de
  nuevo la lista de la cuenta y registrarlo.
