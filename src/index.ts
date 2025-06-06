import express, { Request, Response } from 'express';
import cors from 'cors';
import { ICreatePayment, YooCheckout } from '@a2seven/yoo-checkout';
import dotenv from 'dotenv';
import { db } from './firebase'; // ваш импорт Firestore
import crypto from 'crypto';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4001;

app.use(cors());
app.use(express.json());

/**
 * 1) Обработчик уведомлений от YooKassa (/api/payment/notification)
 */
app.post('/api/payment/notification', async (req: Request, res: Response) => {
  try {
    const { event, object } = req.body;

    if (!object || !object.id) {
      console.warn('❌ notification: missing object or object.id');
      return res.status(400).json({ error: 'Invalid notification payload' });
    }

    const paymentId = object.id;
    const status = object.status;
    const paid = object.paid || false;
    const capturedAt = object.captured_at ? new Date(object.captured_at) : null;

    // Извлекаем метаданные
    const metadata = object.metadata || {};
    const userUID = metadata.userUID as string | undefined;
    const orderID = metadata.orderID as string | undefined;
    const tariffId = metadata.tariffId as string | undefined;

    console.log(`🔔 Notification received (paymentId=${paymentId}): status="${status}", paid=${paid}, userUID=${userUID}, tariffId=${tariffId}`);

    // 1. Обновляем статус платежа (существующая логика)
    try {
      await db.collection('payments').doc(paymentId).update({
        status,
        paid,
        captured_at: capturedAt,
        updatedAt: new Date()
      });
      console.log(`   → Payment ${paymentId} updated in Firestore`);
    } catch (e) {
      console.error(`   ❌ Failed to update payment ${paymentId}:`, e);
    }

    // 2. Если платеж успешен и есть необходимые метаданные - создаем абонемент
    if (paid && userUID && tariffId) {
      try {
        // Загружаем данные тарифа
        const tariffSnap = await db.collection('tariffs').doc(tariffId).get();
        const tariffData = tariffSnap.data();

        if (!tariffData) {
          console.warn(`❌ Tariff not found: ${tariffId}`);
          return res.status(200).json({ status: 'ok' }); // Все равно возвращаем 200 для ЮKassa
        }

        const now = new Date();
        const duration = tariffData.duration || '1 месяц';
        const sessionCount = tariffData.sessionCount || 0;

        // Рассчитываем дату окончания
        let endDate = new Date(now);
        if (duration.includes('месяц')) {
          const months = parseInt(duration) || 1;
          endDate.setMonth(endDate.getMonth() + months);
        } else if (duration.includes('день')) {
          const days = parseInt(duration) || 30;
          endDate.setDate(endDate.getDate() + days);
        }

        // Создаем новый абонемент
        const subscriptionRef = await db.collection('subscriptions').add({
          userId: userUID,
          tariffId: tariffId,
          paymentId: paymentId,
          startDate: now,
          endDate: endDate,
          totalSessions: sessionCount,
          remainingSessions: sessionCount,
          isActive: true,
          createdAt: now,
          lastUsed: null
        });

        console.log(`   → Created subscription ${subscriptionRef.id} for user ${userUID}`);

        // Обновляем пользователя (существующая логика)
        await db.collection('users').doc(userUID).update({
          activeTariffId: tariffId,
          subscriptionStartDate: now,
          subscriptionEndDate: endDate,
          remainingSessions: sessionCount,
          activeSubscriptionId: subscriptionRef.id // Добавляем ссылку на абонемент
        });

      } catch (e) {
        console.error(`❌ Failed to create subscription:`, e);
        // Не прерываем выполнение, просто логируем ошибку
      }
    }

    // Всегда возвращаем 200 для ЮKassa
    res.status(200).json({ status: 'ok' });

  } catch (error) {
    console.error('❌ Notification processing error:', error);
    res.status(500).json({ error: 'Failed to process notification' });
  }
});

/**
 * 2) Обработчик создания платежа (/api/payment)
 */
app.post('/api/payment', async (req: Request, res: Response) => {
  const checkout = new YooCheckout({
    shopId:    process.env.YOO_SHOP_ID   || '1097556',
    secretKey: process.env.YOO_SECRET_KEY || 'test_6tcxjw66EmU5GqLrOQi77AlgKg4Tad64cVgn_cpPthI'
  });

  // Достаём всё из тела
  const { value, userUID, orderID, return_url, tariffId } = req.body;

  if (!value || !userUID || !orderID || !return_url || !tariffId) {
    console.warn('❌ createPayment: missing required field in body:', req.body);
    return res.status(400).json({ error: 'Missing one of required fields: value, userUID, orderID, return_url, tariffId' });
  }

  const createPayload: ICreatePayment = {
    amount: {
      value: value,
      currency: 'RUB'
    },
    payment_method_data: {
      type: 'bank_card'
    },
    capture: true,
    confirmation: {
      type: 'redirect',
      return_url: return_url
    },
    // Кладу в метаданные ровно те поля, которые потом буду разбирать по ключам userUID, orderID, tariffId
    metadata: {
      userUID: userUID,
      orderID: orderID,
      tariffId: tariffId
    }
  };

  try {
    // Создаём платеж
    const payment = await checkout.createPayment(createPayload, Date.now().toString());

    console.log(`💳 Payment created: id=${payment.id}, status="${payment.status}", confirmation_url=${payment.confirmation?.confirmation_url}`);

    // Обновляем Firestore: создаём новый документ payments с ID = payment.id
    await db.collection('payments').doc(payment.id).set({
      userUID,
      orderID,
      tariffId,
      value,
      status: payment.status,
      createdAt: new Date(),
      paymentID: payment.id,
      confirmation_url: payment.confirmation?.confirmation_url || null
    });

    // Отправляем клиенту весь объект payment (или там только confirmation_url, как вам удобно)
    res.json({ payment });
  } catch (error) {
    console.error('Payment creation error:', error);
    res.status(400).json({ error: 'payment error', details: (error as Error).message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});

// Добавляем в server.ts

/**
 * 3) Генерация QR-кода (/api/subscription/generate-qr)
 */
app.post('/api/subscription/generate-qr', async (req: Request, res: Response) => {
  const { userId } = req.body;
  
  if (!userId) {
    return res.status(400).json({ error: 'User ID is required' });
  }

  try {
    // 1. Проверяем активный абонемент
    const subscriptionSnap = await db.collection('subscriptions')
      .where('userId', '==', userId)
      .where('isActive', '==', true)
      .limit(1)
      .get();

    if (subscriptionSnap.empty) {
      return res.status(404).json({ error: 'No active subscription found' });
    }

    const subscription = subscriptionSnap.docs[0].data();
    if (subscription.remainingSessions <= 0) {
      return res.status(400).json({ error: 'No sessions left' });
    }

    // 2. Генерируем уникальный код
    const qrCode = crypto.randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + 30000); // 30 секунд

    // 3. Сохраняем в Firestore
    await db.collection('qr_codes').doc(qrCode).set({
      userId,
      subscriptionId: subscriptionSnap.docs[0].id,
      createdAt: new Date(),
      expiresAt,
      isUsed: false
    });

    res.json({ 
      qrCode,
      expiresAt,
      remainingSessions: subscription.remainingSessions
    });

  } catch (error) {
    console.error('QR generation error:', error);
    res.status(500).json({ error: 'Failed to generate QR code' });
  }
});

/**
 * 4) Валидация QR-кода (/api/subscription/validate-qr)
 */
app.post('/api/subscription/validate-qr', async (req: Request, res: Response) => {
  const { qrCode, adminId } = req.body;

  try {
    // 1. Получаем код
    const qrSnap = await db.collection('qr_codes').doc(qrCode).get();
    
    if (!qrSnap.exists) {
      return res.status(404).json({ error: 'Invalid QR code' });
    }

    const qrData = qrSnap.data()!;

    // 2. Проверяем срок действия
    if (new Date(qrData.expiresAt) < new Date()) {
      return res.status(400).json({ error: 'QR code expired' });
    }

    if (qrData.isUsed) {
      return res.status(400).json({ error: 'QR code already used' });
    }

    // 3. Помечаем как использованный
    await qrSnap.ref.update({ 
      isUsed: true,
      usedAt: new Date(),
      adminId 
    });

    // 4. Обновляем абонемент
    const subRef = db.collection('subscriptions').doc(qrData.subscriptionId);
    await db.runTransaction(async (t) => {
      const subSnap = await t.get(subRef);
      const subData = subSnap.data()!;
      
      t.update(subRef, {
        remainingSessions: subData.remainingSessions - 1,
        lastUsed: new Date()
      });
    });

    // 5. Записываем историю использования
    await db.collection('subscription_usage').add({
      subscriptionId: qrData.subscriptionId,
      userId: qrData.userId,
      adminId,
      usedAt: new Date(),
      qrCode
    });

    res.json({ success: true });

  } catch (error) {
    console.error('QR validation error:', error);
    res.status(500).json({ error: 'Failed to validate QR code' });
  }
});
