import express, { Request, Response } from 'express';
import cors from 'cors';
import { ICreatePayment, YooCheckout } from '@a2seven/yoo-checkout';
import dotenv from 'dotenv';
import { db } from './firebase';
import { FieldValue } from 'firebase-admin/firestore';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4001;

app.use(cors());
app.use(express.json());

// Вспомогательная функция для обновления профиля пользователя
async function updateUserProfile(
  userId: string,
  tariffId: string,
  tariffData: any
) {
  const userRef = db.collection('users').doc(userId);
  const tariffRef = db.collection('tariffs').doc(tariffId);

  // Получаем данные тарифа
  const tariffDoc = await tariffRef.get();
  if (!tariffDoc.exists) {
    throw new Error(`Tariff ${tariffId} not found`);
  }
  const tariff = tariffDoc.data();

  // Рассчитываем дату окончания подписки
  const startDate = new Date();
  let endDate = new Date();
  
  if (tariff?.duration.includes('месяц')) {
    const months = parseInt(tariff.duration) || 1;
    endDate.setMonth(startDate.getMonth() + months);
  } else if (tariff?.duration.includes('день')) {
    const days = parseInt(tariff.duration) || 30;
    endDate.setDate(startDate.getDate() + days);
  } else {
    // По умолчанию 1 месяц
    endDate.setMonth(startDate.getMonth() + 1);
  }

  // Обновляем профиль пользователя
  await userRef.update({
    activeTariffId: tariffId,
    activeTariffName: tariff?.title || 'Абонемент',
    subscriptionStartDate: startDate,
    subscriptionEndDate: endDate,
    remainingSessions: tariff?.sessionCount || 0,
    totalSessions: tariff?.sessionCount || 0,
    paymentStatus: 'success',
    lastPaymentId: FieldValue.serverTimestamp(),
    isSubscriptionActive: true,
    updatedAt: FieldValue.serverTimestamp(),
  });

  console.log(`User ${userId} profile updated with tariff ${tariffId}`);
}

app.post('/api/payment/notification', async (req: Request, res: Response) => {
  try {
    const { event, object } = req.body;

    if (!object || !object.id) {
      console.warn('❌ Invalid notification payload');
      return res.status(400).json({ error: 'Invalid notification payload' });
    }

    const paymentId = object.id;
    const status = object.status;
    const paid = object.paid || false;
    const capturedAt = object.captured_at ? new Date(object.captured_at) : null;
    const metadata = object.metadata || {};
    const userUID = metadata.userUID as string | undefined;
    const tariffId = metadata.tariffId as string | undefined;

    console.log(`🔔 Payment notification: ${paymentId}, status: ${status}, user: ${userUID}`);

    // Основное обновление платежа
    const paymentUpdate: any = {
      status,
      paid,
      updatedAt: FieldValue.serverTimestamp(),
    };

    if (capturedAt) {
      paymentUpdate.captured_at = capturedAt;
    }

    await db.collection('payments').doc(paymentId).update(paymentUpdate);

    // Обновляем профиль пользователя, если платеж успешен и есть необходимые данные
    if (status === 'succeeded' && paid && userUID && tariffId) {
      try {
        await updateUserProfile(userUID, tariffId, {
          paymentId,
          status,
          capturedAt,
        });

        // Дополнительно обновляем платеж информацией об успешной активации
        await db.collection('payments').doc(paymentId).update({
          userProfileUpdated: true,
          profileUpdatedAt: FieldValue.serverTimestamp(),
        });
      } catch (error) {
        console.error(`❌ Failed to update user profile: ${error}`);
        await db.collection('payments').doc(paymentId).update({
          profileUpdateError: (error as Error).message,
        });
      }
    }

    res.status(200).json({ status: 'ok' });
  } catch (error) {
    console.error('❌ Notification processing error:', error);
    res.status(500).json({ error: 'Failed to process notification' });
  }
});

app.post('/api/payment', async (req: Request, res: Response) => {
  const checkout = new YooCheckout({
    shopId: process.env.YOO_SHOP_ID || '1097556',
    secretKey: process.env.YOO_SECRET_KEY || 'test_6tcxjw66EmU5GqLrOQi77AlgKg4Tad64cVgn_cpPthI',
  });

  const { value, userUID, orderID, return_url, tariffId } = req.body;

  // Усиленная валидация
  if (!value || !userUID || !orderID || !return_url || !tariffId) {
    return res.status(400).json({
      error: 'Missing required fields',
      details: {
        received: req.body,
        required: ['value', 'userUID', 'orderID', 'return_url', 'tariffId']
      }
    });
  }

  try {
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
      metadata: {
        userUID,
        orderID,
        tariffId
      }
    };

    // Добавляем лог перед созданием платежа
    console.log('Creating payment with payload:', createPayload);

    const payment = await checkout.createPayment(createPayload, orderID);

    // Проверка наличия confirmation
    if (!payment || !payment.confirmation) {
      throw new Error('Invalid payment response from YooKassa');
    }

    // Проверка confirmation_url
    const confirmationUrl = payment.confirmation.confirmation_url;
    if (!confirmationUrl) {
      throw new Error('Missing confirmation URL in payment response');
    }

    // Сохраняем платеж в Firestore
    const paymentData = {
      userUID,
      orderID,
      tariffId,
      value,
      status: payment.status,
      createdAt: FieldValue.serverTimestamp(),
      paymentID: payment.id,
      confirmation_url: confirmationUrl,
      rawResponse: payment // Сохраняем полный ответ для отладки
    };

    await db.collection('payments').doc(payment.id).set(paymentData);

    // Возвращаем только необходимые данные
    res.json({
      success: true,
      paymentId: payment.id,
      confirmationUrl: confirmationUrl,
      status: payment.status
    });

  } catch (error) {
    console.error('Payment creation error:', error);
    
    // Подробный ответ об ошибке
    res.status(500).json({
      success: false,
      error: 'Payment creation failed',
      details: error instanceof Error ? error.message : 'Unknown error',
      requestBody: req.body
    });
  }
});
// Эндпоинт для проверки статуса платежа
app.get('/api/payment/:paymentId/status', async (req: Request, res: Response) => {
  try {
    const { paymentId } = req.params;
    const paymentDoc = await db.collection('payments').doc(paymentId).get();

    if (!paymentDoc.exists) {
      return res.status(404).json({ error: 'Payment not found' });
    }

    const paymentData = paymentDoc.data();
    res.json({
      status: paymentData?.status,
      paid: paymentData?.paid,
      userProfileUpdated: paymentData?.userProfileUpdated,
    });
  } catch (error) {
    console.error('Payment status check error:', error);
    res.status(500).json({ error: 'Failed to check payment status' });
  }
});

app.listen(PORT, () => {
  console.log(`Payment service running on port ${PORT}`);
});