# Plan — F1…F11

Camino crítico: F0 → F1 → F2 → F3 → F4 → F5 → F6 → F7 → F8 → F9 → F10 → F11.
Un solo implementador, en orden. Los contratos de búsqueda, datos y
navegador se aprueban en F0 para trabajar por módulos sin alterar fronteras.

- F1 Base, persistencia y trabajo durable (T-V2-009…014): monorepo, migraciones
  y snapshots, cola SQLite con leases y fencing, eventos SSE, secret store y
  cliente xAI con presupuestos persistidos. Puerta G1: instalación privada,
  cola y eventos sobreviven a reinicios, secretos fuera de UI, logs y repo.
- F2 Persona y diez perfiles desde la interfaz (T-V2-015…022): editor de
  identidad, importador de CV, CRUD de empleo y estudios, idiomas, skills,
  autorizaciones, diccionario de conceptos, perfiles, snapshots y políticas.
  Puerta G2: configuración completa sin código; bloqueo explicado si faltan
  datos mínimos.
- F3 Búsqueda avanzada completa (T-V2-023…034): presets booleanos, filtros,
  registro de conectores, Greenhouse, Lever, Ashby, descubrimiento con xAI,
  LinkedIn asistida, extracción full-content, dedupe y scheduler. Puerta G3:
  búsquedas repetibles; los fallos de fuente no se disfrazan de cero
  resultados; la aplicación automática sigue desactivada.
- F4 Análisis, plan y límites (T-V2-035…040): inspección de oferta y ruta,
  assessment, plan versionado, límites de coste y tiempo, chat con preguntas
  para hechos ausentes y preflight. Puerta G4: cada candidatura tiene ruta
  explicada y presupuesto; lo desconocido va a asistencia, no a bucle libre.
- F5 Respuestas canónicas y documentos (T-V2-041…048): resolución semántica,
  anclas históricas, política sensible y voluntaria, CV y carta en inglés,
  render PDF y DOCX, preview y versiones, adjuntos y evaluación semántica.
  Puerta G5: cero hechos inventados y documentos consistentes.
- F6 Navegador visible y compartido (T-V2-049…054): servicio Chromium y
  noVNC, propietario y fencing, retorno con reobservación, pestañas e
  iframes, gate de acceso y cuenta, E2E del visor y canal privado.
  Puerta G6: el usuario opera el mismo formulario y devuelve la sesión sin
  perder campos, cuenta ni protección ante envío.
- F7 Motor común de formularios (T-V2-055…060): escáner FieldDescriptor,
  drivers comunes, estabilización, wizard multipantalla, integración de
  historial y voluntarios, y suite contractual con fixture nueva.
  Puerta G7: una fixture nueva con clases soportadas no exige excepciones
  por texto o empresa.
- F8 Adaptadores ATS desde el mismo contrato (T-V2-061…065): Greenhouse,
  Lever, Ashby, ruta genérica para ATS desconocido y Workday, y un cuarto
  plugin de prueba. Puerta G8: tres adapters compatibles; la certificación
  real espera a F11.
- F9 Envío, correo y reconciliación (T-V2-066…071): SubmissionCoordinator,
  observación previa y posterior al clic, correo opcional con OTP manual,
  reconciliación con evidencia, tombstones ante reinicio y toma, y fault
  injection con contador real. Puerta G9: ninguna ruta puede reabrir un
  envío ambiguo sin reconciliación válida.
- F10 Producto integrado y seguimiento (T-V2-072…075): chat y cola, tablero
  editable, exportaciones y métricas, compose privado con backup y
  restauración. Puerta G10: ciclo integrado y restauración del expediente.
- F11 Pruebas de producto, pilotos y entrega (T-V2-076…080): benchmark final,
  prueba de generalización retenida, pilotos reales elegidos por el usuario
  (tres ATS, dos empresas por ATS), E2E privado y matriz de aceptación con
  cierre firmado. Puerta G11: contrato satisfecho o cierre explícito parcial.
