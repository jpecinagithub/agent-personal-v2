# ADR-004 — Búsqueda por conectores declarados, sin índice global

- Decisión: cada fuente es un conector con capacidades declaradas
  (filtros nativos, posprocesados y no soportados visibles). No existe
  búsqueda global de texto en Greenhouse, Lever o Ashby; se consulta
  board por board y se normaliza con evidencia.
- Alternativas rechazadas: prometer un índice global y usar endpoints
  de contratación de empleadores con credenciales ajenas.
- Consecuencias: el catálogo de empresas es editable sin código y sus
  boards se verifican antes de incorporarse. Los fallos de fuente se
  reportan como parciales, nunca como cero resultados.
