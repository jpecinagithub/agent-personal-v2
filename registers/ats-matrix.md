# Matriz de capacidades ATS — v1 (a partir de T006)

| ATS | Formulario sin cuenta | Verificación visible en F0 | Preguntas personalizadas visibles | Estado F0 |
| Greenhouse | Sí (Stripe, Figma) | reCAPTCHA junto al botón | Sí, vía ?questions=true y en el formulario | A certificar en F11 |
| Lever | Sí (Palantir, Spotify) | Ninguna visible | No expuestas en la API; sí en el formulario | A certificar en F11 |
| Ashby | Sí (Ramp, OpenAI) | Ninguna visible | Sí, en el formulario | A certificar en F11 |
| SmartRecruiters | No inspeccionada en T006 | No inspeccionada | No inspeccionada | Candidata a extensión |
| Workday | No (NVIDIA: paso 1 de 6, crear cuenta) | Ninguna visible en el paso de cuenta | No visibles sin cuenta | Genérica o asistida |

Notas:
- "Ninguna visible" no prueba ausencia al enviar o tras iniciar sesión.
- Las preguntas eliminatorias (autorización, patrocinio) varían por
  puesto, no por ATS: presentes en Palantir y OpenAI, ausentes en el
  formulario revisado de Spotify.
- Límites declarados en fichas: Figma 5 solicitudes en 30 días, OpenAI
  5 en 180 días. El preflight debe respetarlos.
- Un ATS sin piloto real en F11 no queda certificado, aunque su adapter
  pase la suite contractual.
