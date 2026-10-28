# Risks — F0 y F1…F11

- ReCAPTCHA en Greenhouse junto al botón de envío. Riesgo: un reto
  visible en el momento del envío puede detener una candidatura
  automática. Mitigación: el agente se detiene y deriva a asistencia
  humana; nunca se usa CAPTCHA de pago ni evasión. Queda para F6/F8.
- Preguntas eliminatorias por puesto, no por ATS. Riesgo: una respuesta
  incorrecta a autorización de trabajo o patrocinio archiva la
  candidatura. Mitigación: resolución por concepto y ámbito, pregunta
  única ante hecho ausente, y preflight que bloquea ante criterio
  excluyente sin declaración. Queda para F4/F5.
- Workday exige cuenta antes del formulario. Riesgo: presentar Workday
  como certificable. Mitigación: clasificado como genérico/asistido y
  excluido de la certificación inicial.
- Búsqueda web de xAI cara en tokens de entrada. Riesgo: gasto
  descontrolado en descubrimiento. Mitigación: presupuesto separado,
  límite por ejecución y contador de ticks persistido (F1, T-V2-014).
- Desconexión de red no detectada en el spike. Riesgo: el agente sigue
  escribiendo tras perder la sesión humana. Mitigación: heartbeat y
  timeout del servidor de control como aceptación de F6.
- Cobertura geográfica sesgada. Riesgo: el corpus inicial no incluye
  empresas españolas. Mitigación: hueco expuesto, trabajo explícito en
  F3 y pilotos elegidos por el usuario en F11, sin promesas previas.
- Límites de solicitudes por empresa (Figma 5 en 30 días, OpenAI 5 en
  180 días, según fichas). Riesgo: envíos bloqueados por límite.
  Mitigación: el preflight debe conocer y respetar límites declarados.
- Cambios de ATS sin aviso. Riesgo: un formulario cambia de estructura
  y un adapter deja de funcionar. Mitigación: suite contractual con
  fixtures, clasificación de fallo de capacidad y derivación a
  asistencia, no reintentos ciegos.
- Dependencia de una sola cuenta xAI y de un solo modelo fijado.
  Riesgo: retirada o cambio de modelo. Mitigación: el modelo se fija
  tras comprobar la lista real de la cuenta, y el cliente debe tolerar
  alias y sustitución declarada, nunca un nombre imaginado.
