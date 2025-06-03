import express, { Request, Response } from 'express';
import cors from 'cors';
import { ICreatePayment, YooCheckout } from '@a2seven/yoo-checkout';
import dotenv from 'dotenv';
import { db } from './firebase'; // ваш импорт Firestore

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
    const status    = object.status;       // реальный статус из YooKassa
    const paid      = object.paid || false;
    const capturedAt = object.captured_at ? new Date(object.captured_at) : null;

    // Распаковываем метаданные. 
    // Предполагаем, что мы всегда пишем в метаданные camelCase: { userUID, orderID, tariffId }
    const metadata = object.metadata || {};
    const userUID  = metadata.userUID   as string | undefined;
    const orderID  = metadata.orderID   as string | undefined;
    const tariffId = metadata.tariffId  as string | undefined;

    console.log(`🔔 Notification received (paymentId=${paymentId}): status="${status}", paid=${paid}, userUID=${userUID}, tariffId=${tariffId}`);

    // Если в metadata нет userUID или tariffId, фиксируем это в консоле, но всё равно обновляем статус самого платежа
    if (!userUID || !tariffId) {
      console.warn(`⚠️ Metadata is missing userUID or tariffId for payment ${paymentId}. Received metadata=${JSON.stringify(metadata)}`);
    } else {
      // 1) Обновляем документ пользователя: ставим activeTariffId и subscriptionStartDate
      //    Логесим до/после, чтобы видеть, что реально пишет в Firestore
      try {
        await db.collection('users').doc(userUID).update({
          activeTariffId: tariffId,
          subscriptionStartDate: new Date()
        });
        console.log(`   → User ${userUID} updated: activeTariffId="${tariffId}"`);
      } catch (e) {
        console.error(`   ❌ Failed to update user ${userUID}:`, e);
      }
    }

    // 2) Обновляем сам документ payments (чтобы сохранить статус, paid, captured_at и т.д.)
    try {
      await db.collection('payments').doc(paymentId).update({
        status,
        paid,
        captured_at: capturedAt,
        updatedAt: new Date()
      });
      console.log(`   → Payment ${paymentId} in Firestore updated: { status="${status}", paid=${paid}, captured_at=${capturedAt} }`);
    } catch (e) {
      console.error(`   ❌ Failed to update payment ${paymentId} in Firestore:`, e);
    }

    // 3) В случае, если вам нужно сразу что-то вернуть клиенту (YooKassa ждет HTTP 200)
    res.status(200).json({ status: 'ok' });
  } catch (error) {
    console.error('❌ Notification error:', error);
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
