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
app.use(express.json({ 
  verify: (req, res, buf) => {
    (req as any).rawBody = buf;
  }
}));

// Функция для безопасного получения данных тарифа
const getTariffData = (tariffDoc: FirebaseFirestore.DocumentSnapshot) => {
  const data = tariffDoc.data() || {};
  return {
    title: data.title || 'Без названия',
    duration: data.duration || '1 месяц',
    sessionCount: data.sessionCount || 0,
    price: data.price || 0,
    isBest: data.isBest || false
  };
};

app.post('/api/payment/notification', async (req: Request, res: Response) => {
  try {
    const { event, object } = req.body;

    if (!object?.id) {
      console.warn('❌ Invalid notification payload:', req.body);
      return res.status(400).json({ error: 'Invalid notification payload' });
    }

    const { id: paymentId, status, paid = false, captured_at, metadata = {} } = object;
    const { userUID, tariffId } = metadata;

    console.log(`🔔 Payment notification: ${paymentId}, status: ${status}, user: ${userUID}`);

    // Обновляем платеж
    const paymentUpdate: any = {
      status,
      paid,
      updatedAt: FieldValue.serverTimestamp()
    };

    if (captured_at) {
      paymentUpdate.captured_at = new Date(captured_at);
    }

    await db.collection('payments').doc(paymentId).update(paymentUpdate);

    // Обновляем пользователя если платеж успешен
    if (status === 'succeeded' && paid && userUID && tariffId) {
      try {
        const tariffDoc = await db.collection('tariffs').doc(tariffId).get();
        const tariff = getTariffData(tariffDoc);

        const startDate = new Date();
        const endDate = new Date(startDate);
        
        // Расчет даты окончания
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
      } catch (error) {
        console.error(`❌ User update failed: ${error}`);
      }
    }

    res.status(200).json({ status: 'ok' });
  } catch (error) {
    console.error('❌ Notification error:', error);
    res.status(500).json({ error: 'Failed to process notification' });
  }
});

app.post('/api/payment', async (req: Request, res: Response) => {
  const checkout = new YooCheckout({
    shopId: process.env.YOO_SHOP_ID || '1097556',
    secretKey: process.env.YOO_SECRET_KEY || 'test_6tcxjw66EmU5GqLrOQi77AlgKg4Tad64cVgn_cpPthI',
  });

  const { value, userUID, orderID, return_url, tariffId } = req.body;

  // Валидация
  const missingFields = ['value', 'userUID', 'orderID', 'return_url', 'tariffId']
    .filter(field => !req.body[field]);

  if (missingFields.length > 0) {
    return res.status(400).json({ 
      error: 'Missing required fields',
      missingFields
    });
  }

  try {
    // Проверяем тариф
    const tariffDoc = await db.collection('tariffs').doc(tariffId).get();
    if (!tariffDoc.exists) {
      return res.status(404).json({ error: 'Tariff not found' });
    }

    const tariff = getTariffData(tariffDoc);

    // Создаем платеж
    const payment = await checkout.createPayment({
      amount: { value, currency: 'RUB' },
      payment_method_data: { type: 'bank_card' },
      capture: true,
      confirmation: { type: 'redirect', return_url },
      metadata: { userUID, orderID, tariffId }
    }, orderID);

    if (!payment?.confirmation?.confirmation_url) {
      throw new Error('Invalid payment response: no confirmation URL');
    }

    // Подготовка данных для Firestore
    const paymentData = {
      userUID,
      orderID,
      tariffId,
      value: Number(value),
      status: payment.status,
      createdAt: FieldValue.serverTimestamp(),
      paymentID: payment.id,
      confirmation_url: payment.confirmation.confirmation_url,
      tariffData: {
        title: tariff.title,
        duration: tariff.duration,
        sessionCount: tariff.sessionCount,
        price: tariff.price
      },
      // Все остальные поля гарантированно имеют значения
    };

    await db.collection('payments').doc(payment.id).set(paymentData);

    res.json({
      success: true,
      paymentId: payment.id,
      confirmationUrl: payment.confirmation.confirmation_url,
      amount: payment.amount
    });

  } catch (error) {
    console.error('Payment error:', error);
    res.status(500).json({ 
      error: 'Payment failed',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
