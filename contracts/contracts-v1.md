# Contratos v1

## Conector de búsqueda

- Entrada: board o site verificado, filtros declarados (título, ubicación,
  remoto, departamento, equipo, nivel cuando el ATS lo exponga).
- Salida normalizada: id de origen, título, empresa, ATS, URL canónica,
  applyUrl, ubicación, remoto o híbrido, departamento, fecha de
  publicación, fecha de primera vista y evidencia de origen.
- Reglas: sin búsqueda global inventada; un fallo de fuente es un
  resultado parcial con su error, nunca cero resultados; una respuesta
  403 no se clasifica como cierre de la oferta; la dedupe usa la URL
  canónica y la similitud de título y empresa, y exige consulta cuando
  la similitud es ambigua.

## Adaptador de ATS

- Entrada: oferta normalizada y perfil con snapshot.
- Salida: ruta clasificada (certificada, genérica o asistida), lista de
  campos con FieldDescriptor (pregunta, grupo, anclas, restricciones),
  preguntas personalizadas del formulario y señales de resultado.
- Reglas: ninguna respuesta literal de empresa en el código; las
  capacidades se declaran por adapter; un campo no soportado deriva a
  asistencia, no a invención; la suite contractual debe pasar en los
  tres adapters y en un cuarto plugin de prueba sin tocar el núcleo.

## Control del navegador

- Estado: propietario (agent o human), sesión, pestañas, archivos y
  señal de conexión. Toda escritura del agente comprueba propietario y
  conexión antes de actuar.
- Transiciones: take (humano) revoca escrituras; return (agente) exige
  reobservación de título y URL antes de actuar; disconnect pausa el
  bucle; reconnect exige reobservación.
- Reglas: una sola solicitud activa en el navegador; un envío manual
  humano o una pérdida de señal no habilita un duplicado; cada archivo
  queda vinculado a su expediente.

## Envío

- Precondiciones: intento persistido, unicidad persona y oferta,
  preflight superado, snapshot del perfil y documentos versionados.
- Acción final: un solo despacho bajo bloqueo y fencing.
- Verificación: evidencia inequívoca posterior al clic, definida por
  ATS. Sin ella, el estado es unknown y no se reenvía. Un 200 genérico
  no confirma.
- Reconciliación: acción de interfaz con evidencia, decisión e historia.
  La ausencia de correo no habilita un nuevo intento. Los tombstones
  impiden duplicados ante reinicio, toma, borrado y reimportación.

## Hechos declarados

- Un hecho tiene concepto, ámbito, valor, procedencia y fecha. La
  narrativa del LLM no es un hecho. Una pregunta se resuelve por
  concepto y ámbito, incluyendo negación y paráfrasis, y un hecho
  ausente se pregunta una vez. Los hechos sensibles y voluntarios
  siguen su política propia y nunca se infieren ni se promueven desde
  errores de narrativa.
