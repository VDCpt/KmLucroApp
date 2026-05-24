// ================================================================
// KmLucro — functions/index.js  v5.0 RETIFICADO
// Cloud Functions (Node.js 20 · Firebase Functions v2)
//
// Patches Aplicados:
// - PATCH 4 (EV-005): AppCheck ativado
// - PATCH 5 (Lei n.º 32/2021): Logging & Auditoria
// - Stripe HMAC-SHA256 validation (mantém EV-011 positivo)
//
// DEPLOY: firebase deploy --only functions
// SECRETS: firebase functions:secrets:set STRIPE_SECRET_KEY
//          firebase functions:secrets:set STRIPE_WEBHOOK_SECRET
//          firebase functions:secrets:set STRIPE_PRICE_ID
//          firebase functions:secrets:set APP_URL
//          firebase functions:secrets:set ADMIN_UID
// ================================================================

const { onRequest, onCall } = require('firebase-functions/v2/https');
const { setGlobalOptions }  = require('firebase-functions/v2');
const admin                 = require('firebase-admin');
const stripe                = require('stripe');

admin.initializeApp();
const db = admin.firestore();

// Região europeia — latência mínima para PT
setGlobalOptions({ region: 'europe-west1' });

const getStripe = () => stripe(process.env.STRIPE_SECRET_KEY);

// ================================================================
// PATCH 5: Função de auditoria (Lei n.º 32/2021 Art. 11.º)
// ================================================================
async function logAuditEvent(uid, type, details = {}, ipAddress = 'unknown') {
  try {
    await db.collection('auditLog').add({
      uid,
      type,           // 'payment_succeeded', 'checkout_session_created', etc.
      details,        // Dados sanitizados (sem PII sensível)
      ipAddress,      // Rastrear origem
      timestamp:      admin.firestore.FieldValue.serverTimestamp(),
      environment:    process.env.ENVIRONMENT || 'production',
    });
    console.log(`[AUDIT] ${type} by ${uid}`, details);
  } catch (err) {
    console.error('[Audit] Erro ao registar:', err);
  }
}

// ================================================================
// 1. CRIAR SESSÃO DE CHECKOUT STRIPE
//    PATCH 4 (EV-005): AppCheck ativado obrigatoriamente
// ================================================================
exports.createCheckoutSession = onCall(
  { enforceAppCheck: true },  /* PATCH: AppCheck ATIVADO */
  async (request) => {
    if (!request.auth) {
      throw new Error('Autenticação obrigatória.');
    }

    const uid         = request.auth.uid;
    const phoneNumber = request.auth.token.phone_number || null;
    const ipAddress   = request.rawRequest?.ip || 'unknown';

    try {
      // Verificar se o utilizador já tem customer Stripe
      const userDoc       = await db.collection('users').doc(uid).get();
      const userData      = userDoc.data() || {};
      let stripeCustomerId = userData.stripeCustomerId;

      if (!stripeCustomerId) {
        // Criar customer Stripe — Phone Auth não tem e-mail por defeito
        const customerData = {
          metadata: { firebaseUID: uid },
          description: `KmLucro · UID: ${uid}`,
        };
        if (phoneNumber) customerData.phone = phoneNumber;

        const customer   = await getStripe().customers.create(customerData);
        stripeCustomerId = customer.id;

        await db.collection('users').doc(uid).update({ stripeCustomerId });
        
        // PATCH 5: Log auditoria
        await logAuditEvent(uid, 'stripe_customer_created', 
          { stripeCustomerId }, ipAddress);
      }

      // Criar sessão de checkout
      const session = await getStripe().checkout.sessions.create({
        customer: stripeCustomerId,
        payment_method_types: ['card'],
        line_items: [{
          price:    process.env.STRIPE_PRICE_ID,
          quantity: 1,
        }],
        mode: 'subscription',
        customer_update: { name: 'auto' },
        success_url: `${process.env.APP_URL}?subscribed=true`,
        cancel_url:  `${process.env.APP_URL}?subscribed=false`,
        subscription_data: {
          trial_period_days: 0,
          metadata: { firebaseUID: uid },
        },
        metadata: { firebaseUID: uid },
        locale: 'pt',
      });

      // PATCH 5: Log auditoria
      await logAuditEvent(uid, 'checkout_session_created', 
        { sessionId: session.id }, ipAddress);

      return { sessionId: session.id, url: session.url };
    } catch (err) {
      // PATCH 5: Log erro
      await logAuditEvent(uid, 'checkout_session_error', 
        { error: err.message }, ipAddress);
      throw err;
    }
  }
);

// ================================================================
// 2. WEBHOOK STRIPE — validação HMAC-SHA256 (EV-011: POSITIVO)
//    Recebe eventos de pagamento e actualiza o Firestore.
//    O campo isSubscribed SÓ é escrito aqui — nunca pelo cliente.
// ================================================================
exports.stripeWebhook = onRequest(
  { cors: false },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).send('Method Not Allowed');
      return;
    }

    const sig           = req.headers['stripe-signature'];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    const ipAddress     = req.ip || 'unknown';

    let event;
    try {
      // Validação HMAC-SHA256 (EV-011: CORRECTO)
      event = getStripe().webhooks.constructEvent(
        req.rawBody, sig, webhookSecret
      );
    } catch (err) {
      console.error('[Webhook] Assinatura inválida:', err.message);
      res.status(400).send(`Webhook Error: ${err.message}`);
      return;
    }

    try {
      switch (event.type) {

        // Pagamento bem-sucedido
        case 'invoice.payment_succeeded': {
          const invoice      = event.data.object;
          const uid          = await getUID(invoice.customer);
          if (!uid) { 
            console.error('[Webhook] UID não encontrado para customer:', invoice.customer);
            res.status(400).send('UID não encontrado'); 
            return; 
          }

          const subscription = await getStripe().subscriptions.retrieve(
            invoice.subscription
          );

          await db.collection('users').doc(uid).update({
            isSubscribed:         true,
            subscriptionStatus:   subscription.status,
            stripeSubscriptionId: subscription.id,
            currentPeriodEnd:     admin.firestore.Timestamp.fromMillis(
              subscription.current_period_end * 1000
            ),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });

          // PATCH 5: Log auditoria
          await logAuditEvent(uid, 'payment_succeeded', 
            { invoiceId: invoice.id, amount: invoice.amount_paid }, ipAddress);
          
          console.log(`[Webhook] ✅ Subscrição activada: ${uid}`);
          break;
        }

        // Subscrição cancelada
        case 'customer.subscription.deleted': {
          const subscription = event.data.object;
          const uid          = await getUIDFromSub(subscription);
          if (!uid) { 
            console.error('[Webhook] UID não encontrado para subscription:', subscription.id);
            res.status(400).send('UID não encontrado'); 
            return; 
          }

          await db.collection('users').doc(uid).update({
            isSubscribed:       false,
            subscriptionStatus: 'canceled',
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });

          // PATCH 5: Log auditoria
          await logAuditEvent(uid, 'subscription_canceled', 
            { subscriptionId: subscription.id }, ipAddress);
          
          console.log(`[Webhook] ❌ Subscrição cancelada: ${uid}`);
          break;
        }

        // Pagamento falhado
        case 'invoice.payment_failed': {
          const invoice = event.data.object;
          const uid     = await getUID(invoice.customer);
          if (!uid) break;

          await db.collection('users').doc(uid).update({
            subscriptionStatus: 'past_due',
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });

          // PATCH 5: Log auditoria
          await logAuditEvent(uid, 'payment_failed', 
            { invoiceId: invoice.id }, ipAddress);
          
          console.warn(`[Webhook] ⚠ Pagamento falhado: ${uid}`);
          break;
        }

        // Subscrição actualizada
        case 'customer.subscription.updated': {
          const subscription = event.data.object;
          const uid          = await getUIDFromSub(subscription);
          if (!uid) break;

          const isActive = ['active', 'trialing'].includes(subscription.status);

          await db.collection('users').doc(uid).update({
            isSubscribed:       isActive,
            subscriptionStatus: subscription.status,
            currentPeriodEnd:   admin.firestore.Timestamp.fromMillis(
              subscription.current_period_end * 1000
            ),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });

          // PATCH 5: Log auditoria
          await logAuditEvent(uid, 'subscription_updated', 
            { subscriptionId: subscription.id, status: subscription.status }, ipAddress);
          
          break;
        }

        default:
          break;
      }

      res.status(200).json({ received: true });

    } catch (err) {
      console.error('[Webhook] Erro ao processar evento:', err);
      res.status(500).send('Erro interno');
    }
  }
);

// ================================================================
// 3. PORTAL DE CLIENTE STRIPE
// ================================================================
exports.createCustomerPortalSession = onCall(
  { enforceAppCheck: true },  /* PATCH: AppCheck ATIVADO */
  async (request) => {
    if (!request.auth) throw new Error('Autenticação obrigatória.');

    const uid            = request.auth.uid;
    const ipAddress      = request.rawRequest?.ip || 'unknown';

    try {
      const userDoc        = await db.collection('users').doc(uid).get();
      const stripeCustomerId = userDoc.data()?.stripeCustomerId;

      if (!stripeCustomerId) throw new Error('Sem subscrição activa.');

      const session = await getStripe().billingPortal.sessions.create({
        customer:   stripeCustomerId,
        return_url: process.env.APP_URL,
        locale: 'pt',
      });

      // PATCH 5: Log auditoria
      await logAuditEvent(uid, 'portal_session_created', {}, ipAddress);

      return { url: session.url };
    } catch (err) {
      // PATCH 5: Log erro
      await logAuditEvent(uid, 'portal_session_error', 
        { error: err.message }, ipAddress);
      throw err;
    }
  }
);

// ================================================================
// 4. ACTIVAR SUBSCRIÇÃO MANUALMENTE (apenas ADMIN)
//    Verificação segura: comparar com ADMIN_UID do environment
// ================================================================
exports.activateSubscription = onCall(
  { enforceAppCheck: true },  /* PATCH: AppCheck ATIVADO */
  async (request) => {
    if (!request.auth) throw new Error('Autenticação obrigatória.');

    const ADMIN_UID    = process.env.ADMIN_UID || 'NOT_SET';
    const callerUID    = request.auth.uid;
    const targetUID    = request.data.uid;
    const ipAddress    = request.rawRequest?.ip || 'unknown';

    if (callerUID !== ADMIN_UID) {
      // PATCH 5: Log tentativa não-autorizada
      await logAuditEvent(callerUID, 'admin_access_denied', 
        { targetUID, reason: 'not_admin' }, ipAddress);
      throw new Error('Permissão negada.');
    }

    try {
      await db.collection('users').doc(targetUID).update({
        isSubscribed:       true,
        subscriptionStatus: 'active',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // PATCH 5: Log auditoria
      await logAuditEvent(targetUID, 'manual_activation', 
        { activatedBy: callerUID }, ipAddress);
      
      console.log(`[Admin] ✅ Subscrição activada manualmente: ${targetUID} por ${callerUID}`);
      return { success: true };
    } catch (err) {
      // PATCH 5: Log erro
      await logAuditEvent(callerUID, 'admin_activation_error', 
        { targetUID, error: err.message }, ipAddress);
      throw err;
    }
  }
);

// ================================================================
// UTILITÁRIOS INTERNOS
// ================================================================

/** Obter UID Firebase a partir do Stripe Customer ID */
async function getUID(stripeCustomerId) {
  try {
    const customer = await getStripe().customers.retrieve(stripeCustomerId);
    if (customer.metadata?.firebaseUID) return customer.metadata.firebaseUID;
  } catch (err) {
    console.error('[getUID] Erro ao obter customer:', err);
  }

  const snapshot = await db.collection('users')
    .where('stripeCustomerId', '==', stripeCustomerId)
    .limit(1)
    .get();

  return snapshot.empty ? null : snapshot.docs[0].id;
}

/** Obter UID a partir de um objeto Subscription */
async function getUIDFromSub(subscription) {
  if (subscription.metadata?.firebaseUID) return subscription.metadata.firebaseUID;
  return getUID(subscription.customer);
}
