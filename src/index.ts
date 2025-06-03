import express, { Request, Response } from 'express';
import cors from 'cors';
import { ICreatePayment, YooCheckout } from '@a2seven/yoo-checkout';
import dotenv from 'dotenv';
import { db } from './firebase'; // 👈

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4001;

app.use(cors());
app.use(express.json());

app.post('/api/payment/notification', async (req: Request, res: Response) => {
  try {
    const { event, object } = req.body;

    if (!object || !object.id) {
      return res.status(400).json({ error: 'Invalid notification payload' });
    }

    const paymentId = object.id;
    const status = object.status;
    const metadata = object.metadata || {};
    const userUID = metadata.userUID as string | undefined;
    const tariffId = metadata.tariffId as string | undefined;

    // Если в metadata нет userUID или tariffId, завершаем без обновления
    if (!userUID || !tariffId) {
      console.warn(`Metadata is missing userUID or tariffId for payment ${paymentId}`);
    } else {
      // 1) Обновляем документ пользователя: ставим activeTariffId и subscriptionStartDate
      await db.collection('users').doc(userUID).update({
        activeTariffId: tariffId,
        subscriptionStartDate: new Date()
      });
    }

    // 2) Обновляем сам документ payments (чтобы сохранить статус, время и проч.)
    await db.collection('payments').doc(paymentId).update({
      status,
      paid: object.paid || false,
      captured_at: object.captured_at ? new Date(object.captured_at) : null,
      updatedAt: new Date()
    });

    console.log(`✅ Payment ${paymentId} processed: status=${status}, user=${userUID}, tariff=${tariffId}`);
    res.status(200).json({ status: 'ok' });
  } catch (error) {
    console.error('❌ Notification error:', error);
    res.status(500).json({ error: 'Failed to process notification' });
  }
});
  

app.post('/api/payment', async (req: Request, res: Response) => {
  const checkout = new YooCheckout({
    shopId: '1097556',
    secretKey: 'test_6tcxjw66EmU5GqLrOQi77AlgKg4Tad64cVgn_cpPthI'
  });
  const { value, userUID, orderID, return_url, tariffId } = req.body;
  const createPayload: ICreatePayment = {
    amount: {
      value: req.body.value,
      currency: 'RUB'
    },
    payment_method_data: {
      type: 'bank_card'
    },
    capture: true,
    confirmation: {
      type: 'redirect',
      return_url: req.body.return_url
    },
    metadata: {
      userUID: req.body.userUID,
      orderID: req.body.orderID,
      tariffID: req.body.tariffID
    }
  };

  try {
    const payment = await checkout.createPayment(createPayload, Date.now().toString());

    // 👇 Обновляем Firestore
       await db.collection('payments').doc(payment.id).set({
      userUID,
      orderID,
      tariffId,                    // сохраним тариф здесь тоже
      value,
      status: payment.status,
      createdAt: new Date(),
      paymentID: payment.id,
      confirmation_url: payment.confirmation?.confirmation_url || null
    });

    res.json({ payment });
  } catch (error) {
    console.error('Payment error:', error);
    res.status(400).json({ error: 'payment error' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
