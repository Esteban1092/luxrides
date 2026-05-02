const admin = require('firebase-admin');
const logger = require('firebase-functions/logger');
const { onValueCreated, onValueWritten } = require('firebase-functions/v2/database');
const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');

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

// =====================================================================
// RETIROS AUTOMÁTICOS CON STRIPE
// =====================================================================

const stripeSecretKey = defineSecret('STRIPE_SECRET_KEY');

// ── Registrar tarjeta de débito del chofer en Stripe Connect ──
exports.registrarTarjetaChofer = onRequest(
  { secrets: [stripeSecretKey] },
  async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
    if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'Method Not Allowed' }); return; }

    const { choferId, choferNombre, titular, email, nombre, cardToken, cardLast4, cardExpMonth, cardExpYear } = req.body || {};

    if (!choferId || !cardToken) {
      res.status(400).json({ ok: false, error: 'Faltan datos requeridos.' }); return;
    }

    const stripe = require('stripe')(stripeSecretKey.value());
    try {
      // 1. Obtener o crear cuenta Stripe Connect
      let stripeAccountId;
      const stripeSnap = await db.ref('choferes/' + choferId + '/stripeAccountId').once('value');
      stripeAccountId = stripeSnap.val();

      if (!stripeAccountId) {
        const nameParts = (choferNombre || 'Chofer LuxRides').split(' ');
        const account = await stripe.accounts.create({
          type: 'custom',
          country: 'MX',
          email: email || undefined,
          capabilities: { transfers: { requested: true } },
          business_type: 'individual',
          individual: {
            first_name: nameParts[0] || 'Chofer',
            last_name: nameParts.slice(1).join(' ') || 'LuxRides',
            email: email || undefined
          },
          tos_acceptance: { service_agreement: 'recipient' },
          metadata: { choferId, choferNombre: choferNombre || '', email: email || '' }
        });
        stripeAccountId = account.id;
        await db.ref('choferes/' + choferId).update({
          stripeAccountId,
          stripeAccountCreadoEn: new Date().toISOString()
        });
        logger.info('Cuenta Stripe Connect creada', { choferId, stripeAccountId });
      }

      // 2. Eliminar tarjeta anterior con el mismo last4 (evitar duplicados)
      const existing = await stripe.accounts.listExternalAccounts(
        stripeAccountId, { object: 'card', limit: 20 }
      );
      const dup = existing.data.find(c => c.last4 === cardLast4);
      if (dup) {
        await stripe.accounts.deleteExternalAccount(stripeAccountId, dup.id);
        logger.info('Tarjeta duplicada eliminada', { choferId, dupId: dup.id });
      }

      // 3. Agregar nueva tarjeta via token
      const card = await stripe.accounts.createExternalAccount(stripeAccountId, {
        external_account: cardToken
      });

      logger.info('Tarjeta de débito registrada en Stripe', { choferId, cardId: card.id, last4: card.last4 });
      res.status(200).json({ ok: true, cardId: card.id, stripeAccountId });

    } catch (err) {
      logger.error('Error registrando tarjeta', { choferId, error: err?.message, code: err?.code });
      res.status(500).json({ ok: false, error: err?.message || 'Error registrando tarjeta.' });
    }
  }
);

exports.procesarSolicitudRetiro = onValueCreated(
  { ref: '/solicitudes_retiro/{solicitudId}', secrets: [stripeSecretKey] },
  async (event) => {
    const solicitud = event.data.val();
    const solicitudId = event.params.solicitudId;
    const ref = db.ref('solicitudes_retiro/' + solicitudId);

    const { choferId, choferNombre, titular, email, monto, stripeCardId, cardLast4, banco } = solicitud || {};

    if (!choferId || !monto || !stripeCardId) {
      logger.warn('Solicitud de retiro con datos incompletos', { solicitudId });
      await ref.update({
        status: 'error',
        error: 'Datos incompletos: falta choferId, monto o tarjeta registrada.',
        errorEn: new Date().toISOString()
      });
      return;
    }

    const stripe = require('stripe')(stripeSecretKey.value());

    try {
      await ref.update({
        status: 'en_proceso',
        procesadoEn: new Date().toISOString()
      });

      // 1. Obtener stripeAccountId (ya creado en registrarTarjetaChofer)
      const stripeSnap = await db.ref('choferes/' + choferId + '/stripeAccountId').once('value');
      const stripeAccountId = stripeSnap.val();

      if (!stripeAccountId) {
        throw new Error('El chofer no tiene cuenta Stripe. Debe registrar su tarjeta primero.');
      }

      // 2. Usar el stripeCardId ya registrado
      const bankAccountId = stripeCardId;

      // 3. Transferir desde la cuenta de la plataforma → cuenta Connect del chofer
      const transfer = await stripe.transfers.create({
        amount: Math.round(monto * 100),
        currency: 'mxn',
        destination: stripeAccountId,
        transfer_group: solicitudId,
        metadata: { solicitudId, choferId, banco: banco || '', cardLast4: cardLast4 || '' }
      });

      logger.info('Transferencia Stripe creada', { solicitudId, choferId, monto, transferId: transfer.id });

      // 4. Payout instantáneo → tarjeta de débito del chofer
      const payout = await stripe.payouts.create(
        {
          amount: Math.round(monto * 100),
          currency: 'mxn',
          destination: bankAccountId,
          method: 'instant',
          statement_descriptor: 'LUXRIDES PAGO',
          metadata: { solicitudId, choferId, cardLast4: cardLast4 || '' }
        },
        { stripeAccount: stripeAccountId }
      );

      logger.info('Payout instantáneo a tarjeta creado', { solicitudId, choferId, payoutId: payout.id });

      // 5. Marcar como pagado en Firebase
      await ref.update({
        status: 'pagado',
        stripeAccountId,
        stripeTransferId: transfer.id,
        stripePayoutId: payout.id,
        payoutMethod: 'instant',
        pagadoEn: new Date().toISOString()
      });

      // 6. Limpiar saldo en proceso del chofer
      await db.ref('choferes/' + choferId).update({
        saldo_en_proceso: 0,
        ultimo_pago_en: new Date().toISOString(),
        ultimo_stripe_transfer: transfer.id
      });

    } catch (error) {
      const errorMsg = error?.message || 'Error desconocido al procesar el pago';
      const stripeCode = error?.code || '';

      logger.error('Error procesando retiro con Stripe', {
        solicitudId,
        choferId,
        errorMsg,
        stripeCode
      });

      await ref.update({
        status: 'error',
        error: errorMsg,
        stripeCode,
        errorEn: new Date().toISOString()
      });

      // Restaurar saldo disponible desde en_proceso al producirse un error
      try {
        const choferRef = db.ref('choferes/' + choferId);
        const choferSnap = await choferRef.once('value');
        const choferData = choferSnap.val() || {};
        const enProceso = Number(choferData.saldo_en_proceso || 0);
        if (enProceso > 0) {
          await choferRef.update({
            saldo_disponible: Number(choferData.saldo_disponible || 0) + enProceso,
            saldo_en_proceso: 0
          });
          logger.info('Saldo restaurado al chofer por error en Stripe', { choferId, enProceso });
        }
      } catch (restoreErr) {
        logger.error('Error restaurando saldo del chofer', {
          choferId,
          error: restoreErr?.message
        });
      }
    }
  }
);