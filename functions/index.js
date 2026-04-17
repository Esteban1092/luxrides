const admin = require('firebase-admin');
const logger = require('firebase-functions/logger');
const { onValueCreated, onValueWritten } = require('firebase-functions/v2/database');
const { onRequest } = require('firebase-functions/v2/https');

admin.initializeApp();

const db = admin.database();
const messaging = admin.messaging();

function toStringMap(data) {
  const result = {};
  Object.entries(data || {}).forEach(([key, value]) => {
    if (value === undefined || value === null) return;
    result[key] = String(value);
  });
  return result;
}

function buildMessage(payload) {
  const token = String(payload?.token || '').trim();
  if (!token) {
    throw new Error('Payload sin token FCM');
  }

  const notification = payload?.notification || {};
  const data = toStringMap(payload?.data || {});
  const title = notification.title || data.title || 'Nuevo viaje LuxRides';
  const body = notification.body || data.body || 'Hay un servicio esperando.';
  const link = data.click_action || data.url || '/';

  return {
    token,
    data: {
      ...data,
      title,
      body,
      click_action: link
    },
    android: {
      priority: 'high',
      notification: {
        channelId: 'luxrides-viajes',
        priority: 'max',
        sound: 'default',
        defaultSound: true,
        defaultVibrateTimings: true,
        visibility: 'public'
      }
    },
    apns: {
      headers: {
        'apns-priority': '10'
      },
      payload: {
        aps: {
          sound: 'default',
          badge: 1,
          contentAvailable: true
        }
      }
    },
    webpush: {
      headers: {
        Urgency: 'high'
      },
      fcmOptions: {
        link
      }
    }
  };
}

async function markQueueStatus(ref, patch) {
  await ref.update({
    ...patch,
    updatedAt: new Date().toISOString()
  });
}

async function cleanupInvalidToken(payload, errorCode) {
  const choferId = String(payload?.data?.choferId || '').trim();
  if (!choferId) return;
  if (!['messaging/registration-token-not-registered', 'messaging/invalid-registration-token'].includes(errorCode)) {
    return;
  }

  await db.ref('choferes/' + choferId).update({
    fcmToken: null,
    fcmTokenUpdatedAt: new Date().toISOString(),
    fcmTokenError: errorCode
  });
}

async function sendPushPayload(payload) {
  const message = buildMessage(payload);
  const messageId = await messaging.send(message);
  return { messageId };
}

exports.processPushQueue = onValueCreated('/push_queue/{pushId}', async (event) => {
  const payload = event.data.val();
  const pushId = event.params.pushId;
  const ref = db.ref('push_queue/' + pushId);

  if (!payload) {
    logger.warn('push_queue sin payload', { pushId });
    return;
  }

  try {
    await markQueueStatus(ref, {
      status: 'processing',
      processingAt: new Date().toISOString()
    });

    const result = await sendPushPayload(payload);

    await markQueueStatus(ref, {
      status: 'sent',
      sentAt: new Date().toISOString(),
      messageId: result.messageId,
      error: null
    });

    logger.info('Push enviado correctamente', {
      pushId,
      choferId: payload?.data?.choferId || '',
      messageId: result.messageId
    });
  } catch (error) {
    const errorCode = error?.code || 'unknown';
    const errorMessage = error?.message || 'Error desconocido enviando push';

    await markQueueStatus(ref, {
      status: 'error',
      error: errorMessage,
      errorCode,
      failedAt: new Date().toISOString()
    });

    await cleanupInvalidToken(payload, errorCode);

    logger.error('Error enviando push', {
      pushId,
      choferId: payload?.data?.choferId || '',
      errorCode,
      errorMessage
    });
  }
});

exports.sendChoferPush = onRequest(async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method Not Allowed' });
    return;
  }

  const expectedToken = process.env.LUXRIDES_PUSH_ENDPOINT_TOKEN || '';
  if (expectedToken) {
    const authHeader = String(req.get('authorization') || '');
    const receivedToken = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (receivedToken !== expectedToken) {
      res.status(401).json({ ok: false, error: 'Unauthorized' });
      return;
    }
  }

  try {
    const payload = req.body || {};
    const result = await sendPushPayload(payload);
    res.status(200).json({ ok: true, messageId: result.messageId });
  } catch (error) {
    logger.error('Error en sendChoferPush', {
      errorCode: error?.code || 'unknown',
      errorMessage: error?.message || 'Sin mensaje'
    });
    res.status(500).json({
      ok: false,
      error: error?.message || 'No se pudo enviar el push'
    });
  }
});

// ── Notificaciones automáticas por cambio de estado de reserva ──

async function sendSafePush(token, title, body, extraData) {
  if (!token) return null;
  try {
    const message = buildMessage({
      token,
      notification: { title, body },
      data: { ...extraData, title, body }
    });
    const messageId = await messaging.send(message);
    return messageId;
  } catch (err) {
    const code = err?.code || '';
    if (['messaging/registration-token-not-registered', 'messaging/invalid-registration-token'].includes(code)) {
      logger.warn('Token FCM inválido, limpiando', { token: token.substring(0, 20), code });
    } else {
      logger.error('Error enviando push', { code, message: err?.message || '' });
    }
    return null;
  }
}

exports.notificarCambioReserva = onValueWritten('/reservas/{reservaId}', async (event) => {
  const before = event.data.before.val();
  const after = event.data.after.val();
  const reservaId = event.params.reservaId;

  if (!after) return; // reserva eliminada

  const estadoAntes = String(before?.estado || '').toLowerCase();
  const estadoDespues = String(after?.estado || '').toLowerCase();

  // Solo actuar si el estado cambió
  if (estadoAntes === estadoDespues) return;

  const clienteToken = String(after.cliente_fcm_token || '').trim();
  const clienteNombre = after.cliente || 'Cliente';
  const choferId = after.chofer_id || after.chofer_asignado || '';
  const choferNombre = after.chofer_nombre || '';

  // ── Push al CLIENTE según estado ──
  if (clienteToken) {
    let titulo = '';
    let cuerpo = '';

    if (estadoDespues === 'asignado') {
      titulo = '🚗 Chofer asignado';
      cuerpo = choferNombre
        ? `${choferNombre} ha sido asignado a tu viaje. Pronto estará en camino.`
        : 'Un chofer ha sido asignado a tu viaje. Pronto estará en camino.';
    } else if (estadoDespues === 'en curso' || estadoDespues === 'en_curso') {
      titulo = '🚘 Tu conductor ya llegó';
      cuerpo = choferNombre
        ? `${choferNombre} ya está en el punto de recogida. ¡Tu viaje ha iniciado!`
        : '¡Tu conductor ya llegó! El viaje ha iniciado.';
    } else if (estadoDespues === 'completado') {
      titulo = '✅ Viaje completado';
      cuerpo = 'Tu viaje ha finalizado. Puedes dejar una calificación.';
    } else if (estadoDespues === 'cancelado') {
      titulo = '❌ Viaje cancelado';
      cuerpo = 'Tu reserva fue cancelada. Contacta a LuxRides si necesitas ayuda.';
    }

    if (titulo) {
      await sendSafePush(clienteToken, titulo, cuerpo, {
        tag: 'luxrides-reserva-' + reservaId,
        reservaId,
        estado: estadoDespues
      });
      logger.info('Push enviado al cliente', { reservaId, estado: estadoDespues });
    }
  }

  // ── Push al CHOFER cuando se le asigna un nuevo servicio ──
  if (estadoDespues === 'asignado' && choferId) {
    try {
      const choferSnap = await db.ref('choferes/' + choferId + '/fcmToken').once('value');
      const choferToken = String(choferSnap.val() || '').trim();
      if (choferToken) {
        const origen = after.origen || 'Origen pendiente';
        const destino = after.destino || 'Destino pendiente';
        await sendSafePush(choferToken, '🚗 Nuevo servicio asignado', `${clienteNombre} • ${origen} → ${destino}`, {
          tag: 'luxrides-viaje-' + reservaId,
          reservaId,
          choferId,
          cliente: clienteNombre,
          origen,
          destino,
          estado: 'asignado'
        });
        logger.info('Push enviado al chofer', { reservaId, choferId });
      }
    } catch (err) {
      logger.error('Error buscando token del chofer', { choferId, error: err?.message });
    }
  }

  // ── Push al DESPACHO cuando llega un nuevo cliente o el cliente se sube ──
  try {
    const despachoSnap = await db.ref('despacho/fcm/token').once('value');
    const despachoToken = String(despachoSnap.val() || '').trim();
    if (despachoToken) {
      let dTitulo = '';
      let dCuerpo = '';

      // Nueva reserva (antes no existía o no tenía estado)
      if (!estadoAntes && estadoDespues === 'pendiente') {
        const origen = after.origen || 'Origen pendiente';
        dTitulo = '📱 Nuevo cliente';
        dCuerpo = `${clienteNombre} solicita viaje desde ${origen}.`;
      }
      // Cliente recogido (en curso)
      else if ((estadoDespues === 'en curso' || estadoDespues === 'en_curso') && estadoAntes === 'asignado') {
        dTitulo = '🚘 Cliente recogido';
        dCuerpo = choferNombre
          ? `${choferNombre} recogió a ${clienteNombre}. Viaje en curso.`
          : `${clienteNombre} fue recogido. Viaje en curso.`;
      }

      if (dTitulo) {
        await sendSafePush(despachoToken, dTitulo, dCuerpo, {
          tag: 'luxrides-despacho-' + reservaId,
          reservaId,
          estado: estadoDespues
        });
        logger.info('Push enviado al despacho', { reservaId, estado: estadoDespues });
      }
    }
  } catch (err) {
    logger.error('Error enviando push al despacho', { error: err?.message });
  }
});