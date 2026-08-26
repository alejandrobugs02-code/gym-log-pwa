# Gym — mirror de publicación

Espejo público de la PWA local-first de Gym. La fuente canónica del código y
las pruebas vive en `Projects/gym-system/apps/gym/`; este repositorio se
regenera con `publish.ps1` y no se desarrolla a mano.

Solo contiene HTML, CSS, JavaScript, manifest, iconos y la rutina genérica
compilada. No contiene datos personales, tokens ni backend. El historial real
permanece en IndexedDB del dispositivo hasta que Alejandro lo exporta.

## Deploy

GitHub Pages publica `main` desde la raíz del repositorio:
`https://alejandrobugs02-code.github.io/gym-log-pwa/`.

La rutina se cambia en `Brain/65_Gym/rutina-6d-flex.md`, se compila desde el
repo canónico con `npm run catalog` y se promueve con `publish.ps1 -Push`.
