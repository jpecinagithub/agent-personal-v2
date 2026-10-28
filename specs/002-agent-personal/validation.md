# Validation y veredicto G0 — GO LIMITADO

## Criterios de la puerta G0 y su estado

- xAI funciona con las capacidades necesarias: CUMPLIDO.
  Chat, salida estructurada, streaming y herramientas propias funcionan
  con grok-4.20-non-reasoning. La búsqueda web con citas funciona por la
  API Responses con web_search. Usar una API distinta no es una
  limitación si cumple las capacidades exigidas, y aquí las cumple:
  dos llamadas de búsqueda completadas y citas en línea verificadas.
  Lo que sí queda registrado es que chat completions no ofrece esa
  vía (live_search en desuso, 410), para que ningún diseño futuro la
  presuponga.
- Hay búsqueda útil real en fuentes declaradas: CUMPLIDO.
  20 boards verificados en vivo. El pliego exige empresas relevantes
  para las búsquedas, no necesariamente españolas; lo que importa es
  que ofrezcan oportunidades compatibles con los criterios. La ausencia
  de empresas españolas queda como hueco de cobertura expuesto, no
  como incumplimiento de G0, y como trabajo pendiente si el usuario
  quiere cubrir ese segmento en F3 o F11.
- Toma de control real demostrada: CUMPLIDO en el recorrido del spike,
  con una limitación precisa que se explica abajo. El recorrido
  acreditado en T005-SPIKE.md, en un mismo Chromium y una misma
  sesión, fue: lanzamiento headed bajo Xvfb con noVNC en localhost,
  sesión CDP creada, navegación a la página local de prueba, subida de
  fichero leída de vuelta, segunda pestaña abierta desde la misma
  sesión (pages=2), toma humana con escritura del agente rechazada y
  página idéntica (marcador initial sin cambio), devolución con
  reobservación de título y URL y escritura posterior con éxito, y
  pausa ante desconexión con 3 intentos omitidos y escritura posterior
  tras reconectar. Una captura aislada no bastaría; lo que acredita el
  punto es ese recorrido completo, no una imagen.
  Limitación precisa: la desconexión se simuló con la bandera de estado
  de la sesión en el bucle del agente, no matando websockify ni la
  conexión Playwright ni provocando una caída de red real. Por tanto,
  lo probado es que el bucle respeta la señal de desconexión y pausa;
  la detección de una caída real (heartbeat y timeout del servidor de
  control) queda como criterio de aceptación de F6.
- Servidor apto: CUMPLIDO. Oracle ARM64, Docker, imagen Playwright
  existente, servicios en localhost y puertos del spike solo en loopback.
- Contrato de envío seguro probado: CUMPLIDO en los términos de F0.
  El pliego prevé para F0 un prototipo local con contador, no
  candidaturas reales. Aclaración honesta: en T007 se probaron llamadas
  internas alrededor de un incremento de contador, con inyección de
  fallos antes y después de ese incremento, pero NO se probó un clic
  de navegador ni un envío en un formulario. Las interacciones de
  navegador (navegación, subida, pestañas) se probaron por separado en
  T005, sin clic de envío. Probar el clic con fallos antes y después
  sobre un formulario local de pruebas, sin portal real, queda como
  criterio explícito para F9 (T-V2-071) y no se presenta como hecho
  en F0.

## Veredicto: GO LIMITADO (no GO completo, no NO-GO)

Se puede financiar F1…F11 solo con este alcance recortado, que queda
congelado salvo decisión explícita del usuario en una puerta:

- Certificar solo Greenhouse, Lever y Ashby, tras pilotos reales en F11.
  SmartRecruiters como extensión evaluada, no certificada por defecto.
  Workday, iCIMS, Taleo, SuccessFactors y Workable: genéricos o
  asistidos, nunca certificados sin piloto.
- LinkedIn solo asistida e importada. Ninguna automatización.
- Búsqueda web de xAI por Responses, con presupuesto separado y límite
  (ver estimates.md). Sin comprobaciones masivas sin tope.
- Detección real de caída de red y captura visual de noVNC como
  criterios de aceptación de F6, no como supuestos.
- Evidencia inequívoca de envío por ATS como criterio de F8/F9. Sin
  ella, los envíos de ese ATS quedan en unknown.
- Cobertura española como trabajo pendiente de F3/F11, no como promesa.

Si el usuario exige como alcance inicial la certificación de Workday, la
automatización de LinkedIn o una cobertura española garantizada, el
veredicto para ese alcance es NO-GO y debe renegociarse antes de F1.
La cobertura española, por sí sola, no invalida F0: el pliego no la
exige como condición de la puerta.

El expediente local cumple esa parte del pliego. Que el repositorio
GitHub esté todavía pendiente no invalida F0; es un paso práctico
pendiente antes de F1, no una condición incumplida de G0.

## Criterios de aceptación por puerta (resumen)

G1: instalación privada, cola y eventos sobreviven a reinicios, secretos
fuera de UI, logs y repo. G2: configuración completa sin código. G3:
búsquedas repetibles, fallos de fuente visibles. G4: ruta y presupuesto
por candidatura. G5: cero hechos inventados. G6: sesión devuelta sin
pérdida. G7: fixture nueva sin excepciones por empresa. G8: tres adapters
compatibles más cuarto plugin. G9: ningún envío ambiguo reabierto sin
reconciliación. G10: ciclo integrado y restauración. G11: contrato
satisfecho o cierre parcial explícito con pendientes.
