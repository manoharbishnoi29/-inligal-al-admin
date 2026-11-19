// Entry point used by the GitHub Actions workflow.
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { processDue } from './crawl.mjs';

const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!raw) {
  console.error('Missing FIREBASE_SERVICE_ACCOUNT secret. Add it in GitHub: Settings > Secrets and variables > Actions.');
  process.exit(1);
}
let account;
try {
  account = JSON.parse(raw);
} catch {
  console.error('FIREBASE_SERVICE_ACCOUNT is not valid JSON. Paste the full contents of the downloaded key file.');
  process.exit(1);
}
initializeApp({ credential: cert(account) });
const db = getFirestore();

const store = {
  async listSources() {
    const snap = await db.collection('kb_sources').where('type', '==', 'website').get();
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  },
  async getSource(id) {
    const d = await db.collection('kb_sources').doc(id).get();
    return d.exists ? { id: d.id, ...d.data() } : null;
  },
  async updateSource(id, patch) {
    try {
      await db.collection('kb_sources').doc(id).update(patch);
    } catch (e) {
      if (e.code !== 5) throw e; // 5 = NOT_FOUND (deleted meanwhile)
    }
  },
  async existingChunkIds(sourceId) {
    const snap = await db.collection('kb_chunks').where('sourceId', '==', sourceId).select().get();
    return new Set(snap.docs.map((d) => d.id));
  },
  async writeChunks(chunks) {
    for (let i = 0; i < chunks.length; i += 400) {
      const batch = db.batch();
      for (const c of chunks.slice(i, i + 400)) batch.set(db.collection('kb_chunks').doc(c.id), c.data);
      await batch.commit();
    }
  },
  async deleteChunks(ids) {
    for (let i = 0; i < ids.length; i += 400) {
      const batch = db.batch();
      for (const id of ids.slice(i, i + 400)) batch.delete(db.collection('kb_chunks').doc(id));
      await batch.commit();
    }
  },
  async addHistory(entry) {
    await db.collection('kb_history').add(entry);
  },
};

const result = await processDue(store);
console.log(result.length ? JSON.stringify(result) : 'Nothing to do.');
