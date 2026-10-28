# Registro de fuentes — v1 (a partir de T003 y T004)

- Greenhouse Job Board API: GET público por board, lista y detalle,
  ?content=true para descripción y ?questions=true para preguntas del
  formulario. El envío por POST exige la clave del empleador: no es vía
  de candidato. Estado: verificada con 12 boards en T004.
- Lever Postings API: GET público por site, filtros de ubicación,
  compromiso, equipo, departamento y nivel, instancias global y EU. Sin
  búsqueda full-text global y sin preguntas personalizadas expuestas.
  Estado: verificada con 2 sites frescos en T004 más Spotify fresca en
  T006.
- Ashby Public Job Posting API: GET público por board, con
  includeCompensation opcional, isListed, isRemote, workplaceType,
  jobUrl, applyUrl y publishedAt. Sin índice global. Estado: verificada
  con 5 boards en T004.
- SmartRecruiters Posting API: GET público por identificador de empresa,
  con paginación y filtros. Citada como ejemplo de datos públicos sin
  autenticación por diseño. Estado: candidata a extensión, 1 board
  verificado (Ubisoft, 332 ofertas). No certificada en F0.
- LinkedIn: solo búsqueda guardada o asistida, importación de enlaces,
  alertas y resolución a oferta de empresa o ATS. Sin automatización,
  por documentación oficial y por el pliego. Estado: asistida, no
  certificada como fuente automática.
- Catálogo inicial completo, con tokens, totales y huecos, en
  ~/workspace/agent-personal-v2-f0/T004-CATALOG.md.
