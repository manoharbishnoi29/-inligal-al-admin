import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import * as fs from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { firebaseConfig } from './config.js';

export const configured =
  !!firebaseConfig.apiKey && !firebaseConfig.apiKey.startsWith('YOUR_') && !!firebaseConfig.projectId && !firebaseConfig.projectId.startsWith('YOUR_');

export const app = configured ? initializeApp(firebaseConfig) : null;
export const db = app ? fs.getFirestore(app) : null;
export { fs };
