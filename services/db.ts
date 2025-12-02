/**
 * This service uses Google Firebase Firestore as the external database.
 * All operations are performed directly against Firestore using the
 * Firebase Web SDK.
 */

import { Comment, VoteData, UserVotes, QuizQuestion } from '../types';
import { db } from './firebase';
import {
  collection,
  addDoc,
  query,
  where,
  getDocs,
  orderBy,
  updateDoc,
  doc,
  setDoc,
  getDoc,
  runTransaction
} from 'firebase/firestore';

// --- User Identity (kept client-side for simplicity) ---

const USER_NAME_KEY = 'rl_app_username'; // session-scoped now

export const getUserName = (): string | null => {
  try {
    // Use sessionStorage so identity is cleared on full page refresh
    return window.sessionStorage.getItem(USER_NAME_KEY);
  } catch {
    return null;
  }
};

export const setUserName = (name: string): void => {
  try {
    window.sessionStorage.setItem(USER_NAME_KEY, name);
  } catch {
    // ignore
  }
};

// Helper to aggregate votes into a map
function toVoteMap(docs: Array<{ optionId: string; count: number }>): VoteData {
  return docs.reduce((acc, v) => { acc[v.optionId] = v.count; return acc; }, {} as VoteData);
}

// --- Comments ---

export const getComments = async (pageId: string): Promise<Comment[]> => {
  const commentsRef = collection(db, 'comments');
  try {
    const q = query(commentsRef, where('pageId', '==', pageId), orderBy('timestamp', 'desc'));
    const snap = await getDocs(q);
    return snap.docs.map(d => ({ ...(d.data() as Comment), id: d.id }));
  } catch (err: any) {
    // Fallback if composite index missing: Firestore throws an error containing a link
    if (/index/i.test(err.message)) {
      const q = query(commentsRef, where('pageId', '==', pageId));
      const snap = await getDocs(q);
      return snap.docs
        .map(d => ({ ...(d.data() as Comment), id: d.id }))
        .sort((a, b) => b.timestamp - a.timestamp);
    }
    throw err;
  }
};

export const postComment = async (pageId: string, text: string): Promise<Comment> => {
  const userName = getUserName();
  if (!userName) throw new Error('User not identified');

  const ts = Date.now();
  const docRef = await addDoc(collection(db, 'comments'), { pageId, text, userName, timestamp: ts });
  return { id: docRef.id, pageId, text, userName, timestamp: ts };
};

// --- Quiz/Polling ---

export const initVotes = async (questions: QuizQuestion[]) => {
  const optionIds = questions.flatMap(q => q.options.map(o => o.id));
  await Promise.all(optionIds.map(async (optionId) => {
    const voteDocRef = doc(db, 'votes', `vote_${optionId}`);
    const existing = await getDoc(voteDocRef);
    if (!existing.exists()) {
      await setDoc(voteDocRef, { optionId, count: Math.floor(Math.random() * 5) + 1 });
    }
  }));
};

export const getVoteCounts = async (): Promise<VoteData> => {
  const votesCol = collection(db, 'votes');
  const snap = await getDocs(votesCol);
  const docs = snap.docs.map(d => d.data() as { optionId: string; count: number });
  return toVoteMap(docs);
};

export const getUserVotes = async (): Promise<UserVotes> => {
  const userName = getUserName();
  if (!userName) return {};
  const uvCol = collection(db, 'userVotes');
  const q = query(uvCol, where('userName', '==', userName));
  const snap = await getDocs(q);
  const map: UserVotes = {};
  snap.docs.forEach(d => {
    const data = d.data() as { userName: string; questionId: string; optionId: string };
    map[data.questionId] = data.optionId;
  });
  return map;
};

export const submitVote = async (questionId: string, optionId: string): Promise<VoteData> => {
  const userName = getUserName();
  if (!userName) throw new Error('User not identified');

  const uvId = `${userName}__${questionId}`;
  const userVoteRef = doc(db, 'userVotes', uvId);
  const prevSnap = await getDoc(userVoteRef);
  const prevOptionId = prevSnap.exists() ? (prevSnap.data() as any).optionId : undefined;

  const newOptionId = optionId;

  // Use a transaction for consistent counters
  await runTransaction(db, async (transaction) => {
    // Decrement previous if changing
    if (prevOptionId && prevOptionId !== newOptionId) {
      const prevVoteRef = doc(db, 'votes', `vote_${prevOptionId}`);
      const prevVoteSnap = await transaction.get(prevVoteRef);
      if (prevVoteSnap.exists()) {
        const prevCount = (prevVoteSnap.data() as any).count || 0;
        transaction.update(prevVoteRef, { count: Math.max(0, prevCount - 1) });
      }
    }
    // Increment new
    const newVoteRef = doc(db, 'votes', `vote_${newOptionId}`);
    const newVoteSnap = await transaction.get(newVoteRef);
    if (newVoteSnap.exists()) {
      const newCount = (newVoteSnap.data() as any).count || 0;
      transaction.update(newVoteRef, { count: newCount + 1 });
    } else {
      transaction.set(newVoteRef, { optionId: newOptionId, count: 1 });
    }
    // Upsert user vote
    transaction.set(userVoteRef, { userName, questionId, optionId: newOptionId }, { merge: true });
  });

  return await getVoteCounts();
};