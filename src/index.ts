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

// Обработчик уведомлений от YooKassa
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
    const userUID = metadata.userUID;
    const tariffId = metadata.tariffId;

    console.log(`🔔 Payment notification: ${paymentId}, status: ${status}, user: ${userUID}`);

    // Обновляем статус платежа
    await db.collection('payments').doc(paymentId).update({
      status,
      paid,
      captured_at: capturedAt,
      updatedAt: FieldValue.serverTimestamp()
    });

    // Если платеж успешен, обновляем профиль пользователя
    if (status === 'succeeded' && paid && userUID && tariffId) {
      try {
        const tariffDoc = await db.collection('tariffs').doc(tariffId).get();
        const tariff = tariffDoc.data();

        if (tariff) {
          const startDate = new Date();
          let endDate = new Date();
          
          // Рассчитываем дату окончания подписки
          if (tariff.duration.includes('месяц')) {
            const months = parseInt(tariff.duration) || 1;
            endDate.setMonth(startDate.getMonth() + months);
          } else {
            const days = parseInt(tariff.duration) || 30;
            endDate.setDate(startDate.getDate() + days);
          }

          await db.collection('users').doc(userUID).update({
            activeTariffId: tariffId,
            activeTariffName: tariff.title,
            subscriptionStartDate: startDate,
            subscriptionEndDate: endDate,
            remainingSessions: tariff.sessionCount,
            totalSessions: tariff.sessionCount,
            isSubscriptionActive: true,
            updatedAt: FieldValue.serverTimestamp()
          });
        }
      } catch (error) {
        console.error(`❌ Failed to update user profile: ${error}`);
      }
    }

    res.status(200).json({ status: 'ok' });
  } catch (error) {
    console.error('❌ Notification processing error:', error);
    res.status(500).json({ error: 'Failed to process notification' });
  }
});

// Обработчик создания платежа
app.post('/api/payment', async (req: Request, res: Response) => {
  const checkout = new YooCheckout({
    shopId: process.env.YOO_SHOP_ID || '1097556',
    secretKey: process.env.YOO_SECRET_KEY || 'test_6tcxjw66EmU5GqLrOQi77AlgKg4Tad64cVgn_cpPthI',
  });

  const { value, userUID, orderID, return_url, tariffId } = req.body;

  if (!value || !userUID || !orderID || !return_url || !tariffId) {
    return res.status(400).json({ 
      error: 'Missing required fields',
      details: req.body
    });
  }

  try {
    // Проверяем существование тарифа
    const tariffDoc = await db.collection('tariffs').doc(tariffId).get();
    if (!tariffDoc.exists) {
      return res.status(404).json({ error: 'Tariff not found' });
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
      metadata: {
        userUID,
        orderID,
        tariffId
      }
    };

    const payment = await checkout.createPayment(createPayload, orderID);

    // Проверяем наличие confirmation_url
    if (!payment.confirmation?.confirmation_url) {
      throw new Error('No confirmation URL in payment response');
    }

    // Сохраняем платеж
    await db.collection('payments').doc(payment.id).set({
      userUID,
      orderID,
      tariffId,
      value,
      status: payment.status,
      createdAt: FieldValue.serverTimestamp(),
      paymentID: payment.id,
      confirmation_url: payment.confirmation.confirmation_url,
      tariffData: {
        title: tariffDoc.data()?.title,
        duration: tariffDoc.data()?.duration,
        sessionCount: tariffDoc.data()?.sessionCount
      }
    });

    res.json({
      success: true,
      paymentId: payment.id,
      confirmationUrl: payment.confirmation.confirmation_url
    });

  } catch (error) {
    console.error('Payment creation error:', error);
    res.status(500).json({ 
      error: 'Payment creation failed',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
