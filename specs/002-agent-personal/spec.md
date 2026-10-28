# Spec — Agente personal de empleo v2 (002)

## Alcance

Asistente privado monousuario que descubre ofertas en fuentes declaradas,
las evalúa contra perfiles declarados, prepara documentos en inglés,
resuelve preguntas por concepto y ámbito, y envía candidaturas por el
formulario alojado del empleador bajo control humano compartido, con
evidencia técnica de envío separada del tablero comercial.

## Fuera de alcance en esta línea base

- Candidaturas en otro idioma que no sea inglés.
- Login, registro o roles en la aplicación.
- Despliegue público.
- Automatización de LinkedIn, proxies, CAPTCHA de pago y evasión.
- Promesa de certificación de Workday, iCIMS, Taleo, SuccessFactors o
  Workable sin piloto real posterior.
- Cualquier proveedor LLM distinto de xAI.

## Entidades principales

- Persona: identidad, contactos, idiomas, skills, enlaces, autorización
  por país, disponibilidad y compensación, todo declarado, nunca inferido.
- Perfil (máximo 10): foco, plantilla, instantáneas versionadas y estado
  de preparación. Cambiar un perfil no altera expedientes anteriores.
- Hecho declarado con ámbito: concepto, ámbito, valor, procedencia y
  fecha. Una pregunta humana se convierte en declaración reutilizable.
- Oferta: fuente, ATS, URL canónica, título, ubicación, idioma detectado,
  fechas de publicación y vigencia separadas, y evidencia de origen.
- Campaña: conjunto de ofertas por perfil, deduplicada entre fuentes.
- Intento de envío: estado persistido antes de la acción final
  (prepared, sent_unverified, verified, unknown, refused_takeover),
  evidencia posterior al clic y registro de reconciliación.
- Sesión de navegador: propietario (agent o human), pestañas, archivos
  vinculados al expediente correcto y señal de desconexión.

## Requisitos trazables

RF-V2-001…100 según el pliego 02-ESPECIFICACION-FUNCIONAL.md.
Los RF de búsqueda, datos, navegador y envío se congelan en F0 y no se
alteran por módulo sin revisión de contrato.
