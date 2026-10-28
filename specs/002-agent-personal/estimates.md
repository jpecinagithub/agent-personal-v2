# Estimación por bloques — F1…F11 (a partir de F0)

Unidad: horas de trabajo del agente (implementación, pruebas y evidencia),
sin contar la espera del usuario ni el tiempo de ejecución de suites.
Base: 72 tareas en 11 bloques, con complejidad creciente en navegador,
adaptadores y envío. Los rangos son amplios a propósito: F0 demostró
capacidades, no el coste de construir cada módulo con sus puertas.

| Bloque | Tareas | Estimación (horas) |
| F1 Base y persistencia | 6 | 16–22 |
| F2 Persona y perfiles | 8 | 18–24 |
| F3 Búsqueda avanzada | 12 | 22–30 |
| F4 Análisis y límites | 6 | 12–18 |
| F5 Respuestas y documentos | 8 | 18–24 |
| F6 Navegador compartido | 6 | 16–22 |
| F7 Motor de formularios | 6 | 14–20 |
| F8 Adaptadores ATS | 5 | 16–22 |
| F9 Envío y reconciliación | 6 | 14–20 |
| F10 Producto integrado | 4 | 12–18 |
| F11 Pilotos y entrega | 5 | 10–16 |
| Total F1…F11 | 72 | 168–236 |

## Cómo se miden las horas del agente

- Una hora del agente es una hora de trabajo enfocado del agente:
  implementación, pruebas y evidencia. No es tiempo de calendario, no
  es tiempo de espera del usuario y no es tiempo de ejecución
  desatendida de suites. Se reporta por puerta, junto con lo entregado,
  la evidencia, los incidentes por familia y la desviación respecto al
  bloque, como exige el pliego.
- El máximo potencial es 236 horas base más 45 de reserva, es decir,
  281 horas. La reserva no es gasto por defecto: solo se usa ante
  cambios aprobados por el usuario en una puerta, y sin esa aprobación
  el trabajo se detiene al agotar el rango base del bloque, se entrega
  lo probado y se decide recortar, ampliar o parar, igual que se hizo
  con el tope de F0.

## Facturación: sin tarifa acordada, no hay precio

- Esta estimación es volumen de trabajo, no una factura. No hay tarifa
  por hora acordada en el pliego ni en F0, ni un mecanismo de cobro
  establecido en esta conversación. Convertir horas en euros sin tarifa
  sería inventar un total.
- Si esas horas fueran facturables, el usuario debe fijar antes de F1
  la tarifa por hora y las condiciones de cobro (qué se factura, cómo
  se reporta y cuándo se paga). Hasta entonces, las horas solo sirven
  para dimensionar el trabajo y el techo, no para cobrarlo.

## Gasto en xAI (estimación, no garantía del proveedor)

- Gasto medido en F0: muy por debajo de 1 dólar en todo el spike.
  Un chat corto costó unos 0,0001 dólares y una búsqueda web por
  Responses unos 0,019 dólares, por el contexto de búsqueda.
- Para F1…F11, con presupuestos persistidos y límites por ejecución, se
  estima un gasto de prueba de 30–60 dólares en total, dominado por las
  búsquedas web si se usan sin tope. Por eso el presupuesto de búsqueda
  web debe fijarse en F1 con un tope duro, y cada puerta debe reportar
  consumo real frente a esta estimación.
- El tope de 20 dólares era solo para F0 y ya no aplica a F1…F11.
  La estimación de 30–60 dólares NO sustituye a un límite aprobado:
  el usuario debe fijar un tope duro nuevo para el desarrollo completo
  antes de F1. Como candidato, el techo de la estimación (60 dólares)
  puede servir de tope, pero solo si el usuario lo aprueba así; hasta
  entonces no hay ningún límite aprobado para F1…F11.

## Tiempo del usuario (estimación)

- F0 pedía 1–2 horas. Para F1…F11 se estiman 8–12 horas en total:
  configuración de persona y perfiles, decisiones en puertas, elección
  de ofertas para los pilotos de F11 y pasos que solo el usuario puede
  hacer (cuentas en portales, captchas y envíos manuales asistidos).
- Los pilotos reales de F11 no se pueden sustituir por ofertas de
  relleno: sin ofertas elegidas por el usuario, la certificación queda
  pendiente y el cierre debe declararse parcial.

## Decisión sobre la parte económica (2026-10-28)

- Por indicación del Director del proyecto, comunicada por el usuario
  el 2026-10-28, la parte económica queda de lado. La prioridad del
  proyecto es cumplir las especificaciones técnicas, no cumplir el
  presupuesto.
- Consecuencia: la tarifa por hora, el tope de gasto xAI y el techo de
  horas dejan de ser condiciones de paso en las puertas. El trabajo no
  se detiene por agotar un rango de horas ni por alcanzar un tope de
  gasto, y no se vuelve a pedir una decisión económica como requisito
  para continuar.
- Lo que se mantiene: en cada puerta se sigue reportando lo entregado,
  la evidencia, los incidentes, el consumo real (horas y gasto xAI) y
  la desviación respecto a la estimación, como exige el pliego. Si el
  consumo se dispara de forma anómala respecto a lo estimado, se avisa
  y se deja constancia, pero no se para el trabajo por ello salvo que
  el usuario o el Director lo ordenen de nuevo.
- La estimación de 168–236 horas más 45 de reserva queda como
  referencia de volumen, no como límite.

## Pendiente antes de F1 (no económico)

- Aprobar el GO limitado con su alcance técnico recortado, o
  renegociar ese alcance.
- Crear el repositorio GitHub para este expediente.
