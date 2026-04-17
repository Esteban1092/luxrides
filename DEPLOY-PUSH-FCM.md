# Despliegue de Push FCM

Este repo ya quedó preparado para enviar notificaciones push reales con Firebase Cloud Functions.

## Lo que ya está listo

- Las apps de chofer guardan `fcmToken` en `choferes/<id>`.
- El despacho escribe en `push_queue` al asignar un viaje.
- La función `processPushQueue` envía el push real por Firebase Cloud Messaging.
- La función `sendChoferPush` también quedó disponible como endpoint HTTP opcional.

## Comandos

Desde la raíz del proyecto:

```bash
npx firebase-tools login
npx firebase-tools deploy --only functions
```

## Archivos clave

- `functions/index.js`
- `functions/package.json`
- `firebase.json`
- `.firebaserc`

## Qué debe aparecer después

Firebase debe desplegar estas funciones:

- `processPushQueue`
- `sendChoferPush`

## Prueba rápida

1. Abrir la app de chofer instalada.
2. Iniciar sesión y aceptar permisos.
3. Verificar en Realtime Database que el chofer tenga `fcmToken`.
4. Asignar un viaje desde despacho.
5. Confirmar que se crea un registro en `push_queue`.
6. Confirmar que ese registro cambia a `status: sent`.
7. Verificar que el teléfono reciba la notificación.

## Si no llega

- Revisar que el chofer tenga `fcmToken` válido.
- Revisar en `push_queue` si quedó `status: error`.
- Si aparece `messaging/registration-token-not-registered`, el chofer debe volver a iniciar sesión para regenerar token.