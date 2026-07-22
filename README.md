# Gym Log v2 — frontend (PWA)

Espejo de solo el frontend estático de Gym Tracker v2. La fuente de verdad del
código (incluido el backend de Apps Script y los tests) vive en el vault
privado de Alejandro, en `Personal/65_Gym/gym-log-v2/`. Este repo se
regenera con `publish-pwa.ps1` (en el vault) — no se edita a mano aquí.

Cero datos personales: solo HTML/CSS/JS/manifest/íconos/rutina genérica. El
historial real de entrenamiento vive en Google Sheets, nunca en este repo.

## Deploy

GitHub Pages → Settings → Pages → Source: `main` / `/(root)`.

## Uso

Abre la URL publicada en Safari (iPhone), pega la URL `/exec` de tu Apps
Script en el campo de Ajustes, y "Añadir a pantalla de inicio".
