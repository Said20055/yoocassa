import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import dotenv from 'dotenv';
dotenv.config();

const raw = process.env.FIREBASE_SERVICE_ACCOUNT;

if (!raw) {
  throw new Error('❌ FIREBASE_SERVICE_ACCOUNT is not defined in .env');
}

let parsedServiceAccount;

try {
  parsedServiceAccount = JSON.parse(raw);
  // Заменяем экранированные символы новой строки только после парсинга
  parsedServiceAccount.private_key = parsedServiceAccount.private_key.replace(/\\n/g, '\n');
} catch (err) {
  console.error('❌ Error parsing FIREBASE_SERVICE_ACCOUNT:', err);
  throw err;
}

initializeApp({
  credential: cert(parsedServiceAccount),
});

export const db = getFirestore();
