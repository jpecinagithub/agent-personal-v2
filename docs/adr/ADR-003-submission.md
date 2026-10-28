# ADR-003 — Envío seguro sin promesa de exactly-once

- Decisión: persistir el intento antes de la acción final, reclamar una
  sola vez bajo bloqueo y fencing, verificar después con evidencia
  inequívoca, y conservar unknown sin reenvío ante cualquier duda.
- Alternativas rechazadas: reintentar ante duda (duplica candidaturas)
  y presentar un 200 genérico o un cambio de estado en el tablero como
  confirmación (fabrica evidencia).
- Consecuencias: un envío ambiguo solo se reabre por reconciliación
  válida con evidencia. El tablero comercial nunca sustituye a la
  evidencia técnica.
