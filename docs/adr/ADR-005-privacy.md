# ADR-005 — Despliegue privado y secretos fuera del repositorio

- Decisión: despliegue solo en localhost, red privada o túnel a Oracle.
  Los secretos viven en el secret store del servidor, nunca en UI, logs
  o repositorio. Las URL y redes permitidas están limitadas y una web
  ajena no puede enviar comandos al portal privado.
- Alternativas rechazadas: publicar el servicio para acceso cómodo y
  guardar claves en ficheros del proyecto.
- Consecuencias: la instalación privada, el cierre de puertos y la
  restauración consistente son criterios de puerta, no detalles finales.
