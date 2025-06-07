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
  console.log(`🔍 Попытка валидации QR-кода: ${qrCode} администратором: ${adminId}`);

  try {
    // 1. Проверяем существование QR-кода
    const qrSnap = await db.collection('qr_codes').doc(qrCode).get();
    
    if (!qrSnap.exists) {
      console.warn(`❌ QR-код не найден: ${qrCode}`);
      return res.status(404).json({ 
        error: 'Неверный QR-код',
        code: 'invalid_qr'
      });
    }

    const qrData = qrSnap.data()!;
    console.log(`ℹ️ Найден QR-код:`, qrData);

    // 2. Проверяем срок действия (с точностью до секунды)
    const now = new Date();
    const expiresAt = new Date(qrData.expiresAt);
    
    console.log(`⌚ Текущее время: ${now.toISOString()}, срок действия: ${expiresAt.toISOString()}`);
    
    if (expiresAt < now) {
      console.warn(`⌛ QR-код просрочен: разница ${(now.getTime() - expiresAt.getTime())/1000} сек`);
      return res.status(400).json({ 
        error: 'QR-код просрочен',
        code: 'qr_expired',
        expiredAt: expiresAt.toISOString()
      });
    }

    // 3. Проверяем, не использован ли уже код
    if (qrData.isUsed) {
      console.warn(`⚠️ QR-код уже использован: использован в ${qrData.usedAt}`);
      return res.status(400).json({ 
        error: 'QR-код уже использован',
        code: 'qr_already_used'
      });
    }

    // 4. Проверяем права администратора
    const adminDoc = await db.collection('admins').doc(adminId).get();
    if (!adminDoc.exists) {
      console.warn(`⛔ Неавторизованный администратор: ${adminId}`);
      return res.status(403).json({ 
        error: 'Доступ запрещен',
        code: 'admin_not_found'
      });
    }

    console.log(`👮 Администратор подтвержден: ${adminDoc.data()?.email}`);

    // 5. Обновляем статус QR-кода
    const batch = db.batch();
    
    batch.update(qrSnap.ref, { 
      isUsed: true,
      usedAt: now,
      adminId: adminId
    });

    // 6. Обновляем абонемент
    const subRef = db.collection('subscriptions').doc(qrData.subscriptionId);
    const subSnap = await subRef.get();
    
    if (!subSnap.exists) {
      console.error(`❌ Абонемент не найден: ${qrData.subscriptionId}`);
      return res.status(404).json({ 
        error: 'Абонемент не найден',
        code: 'subscription_not_found'
      });
    }

    const subData = subSnap.data()!;
    const newRemaining = subData.remainingSessions - 1;
    
    if (newRemaining < 0) {
      console.warn(`⚠️ Недостаточно сессий: ${subData.remainingSessions}`);
      return res.status(400).json({ 
        error: 'Недостаточно сессий в абонементе',
        code: 'no_sessions_left'
      });
    }

    batch.update(subRef, {
      remainingSessions: newRemaining,
      lastUsed: now
    });

    // 7. Записываем историю
    const usageRef = db.collection('subscription_usage').doc();
    batch.set(usageRef, {
      subscriptionId: qrData.subscriptionId,
      userId: qrData.userId,
      adminId: adminId,
      usedAt: now,
      qrCode: qrCode,
      remainingSessions: newRemaining
    });

    await batch.commit();
    
    console.log(`✅ QR-код успешно подтвержден. Осталось сессий: ${newRemaining}`);
    
    res.json({ 
      success: true,
      remainingSessions: newRemaining
    });

  } catch (error) {
    console.error('🔥 Ошибка при валидации QR-кода:', error);
    res.status(500).json({ 
      error: 'Внутренняя ошибка сервера',
      code: 'server_error'
    });
  }
});
