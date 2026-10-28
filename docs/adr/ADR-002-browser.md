# ADR-002 — Un Chromium compartido con propietario y fencing

- Decisión: un solo servicio Chromium visible con noVNC, sesiones en
  volumen privado, y un propietario de control (agent o human) que se
  comprueba antes de cada escritura.
- Alternativas rechazadas: un navegador por tarea (rompe la sesión
  compartida y la cuenta del usuario) y un navegador sin visor (impide
  la asistencia humana real).
- Consecuencias: la toma humana revoca escrituras; la devolución exige
  reobservación; la desconexión pausa el bucle. La detección real de
  caída de red es aceptación de F6, no un supuesto de F0.
