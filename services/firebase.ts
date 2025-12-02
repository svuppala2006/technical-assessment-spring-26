import { initializeApp } from 'firebase/app';
import { getFirestore, enableIndexedDbPersistence, doc, getDoc } from 'firebase/firestore';

// Read Firebase config from Vite env
const firebaseConfig = {
    apiKey: (import.meta as any).env?.VITE_FIREBASE_API_KEY,
    authDomain: (import.meta as any).env?.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: (import.meta as any).env?.VITE_FIREBASE_PROJECT_ID,
    storageBucket: (import.meta as any).env?.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: (import.meta as any).env?.VITE_FIREBASE_MESSAGING_SENDER_ID,
    appId: (import.meta as any).env?.VITE_FIREBASE_APP_ID,
};

Object.entries(firebaseConfig).forEach(([k, v]) => {
    if (!v) throw new Error(`Missing Firebase config: ${k}`);
});

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);

// Attempt offline persistence (optional). Errors ignored (e.g., multiple tabs).
enableIndexedDbPersistence(db).catch(() => {});

export async function diagnoseFirestoreConnectivity(): Promise<{ online: boolean; reason?: string }> {
    if (navigator.onLine === false) return { online: false, reason: 'Browser offline (navigator.onLine false)' };
    if (!firebaseConfig.projectId) return { online: false, reason: 'Missing projectId' };
    // Attempt a metadata doc read (non-existent doc read is allowed and will not require CORS to a raw domain).
    try {
        const sentinelRef = doc(db, '__diagnostics__', 'connectivity');
        await getDoc(sentinelRef); // existence not required
        return { online: true };
    } catch (e: any) {
        // Distinguish permission errors
        if (/permission|denied/i.test(e.message)) {
            return { online: true, reason: 'Permission denied by Firestore rules' };
        }
        return { online: false, reason: e.message || 'Firestore read failed' };
    }
}
