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
function ensureQuestionMap(map: VoteData, questionId: string) {
  if (!map[questionId]) map[questionId] = {} as any;
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
  // Seed vote docs per question+option to ensure isolation between questions
  await Promise.all(
    questions.flatMap(q => q.options.map(async (o) => {
      const voteDocRef = doc(db, 'votes', `vote_${q.id}_${o.id}`);
      const existing = await getDoc(voteDocRef);
      if (!existing.exists()) {
        await setDoc(voteDocRef, { questionId: q.id, optionId: o.id, count: 0 });
      }
    }))
  );
};

export const getVoteCounts = async (questions: QuizQuestion[]): Promise<VoteData> => {
  // Return counts nested by questionId -> optionId
  const result: VoteData = {};
  for (const q of questions) {
    ensureQuestionMap(result, q.id);
    for (const o of q.options) {
      const snap = await getDoc(doc(db, 'votes', `vote_${q.id}_${o.id}`));
      result[q.id][o.id] = snap.exists() ? ((snap.data() as any).count || 0) : 0;
    }
  }
  return result;
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

// Returns a mapping of optionId -> array of user names who voted that option for the given question
export const getOptionVoters = async (questionId: string): Promise<Record<string, string[]>> => {
  const uvCol = collection(db, 'userVotes');
  const q = query(uvCol, where('questionId', '==', questionId));
  const snap = await getDocs(q);
  const result: Record<string, string[]> = {};
  snap.docs.forEach(d => {
    const data = d.data() as { userName: string; questionId: string; optionId: string };
    if (!result[data.optionId]) result[data.optionId] = [];
    result[data.optionId].push(data.userName);
  });
  // Sort names alphabetically for consistent UI
  Object.keys(result).forEach(k => result[k].sort((a, b) => a.localeCompare(b)));
  return result;
};

export const submitVote = async (questionId: string, optionId: string, questions: QuizQuestion[]): Promise<VoteData> => {
  const userName = getUserName();
  if (!userName) throw new Error('User not identified');

  const uvId = `${userName}__${questionId}`;
  const userVoteRef = doc(db, 'userVotes', uvId);
  const prevSnap = await getDoc(userVoteRef);
  const prevOptionId = prevSnap.exists() ? (prevSnap.data() as any).optionId : undefined;

  const newOptionId = optionId;

  // No-op if user clicks the same option again
  if (prevOptionId && prevOptionId === newOptionId) {
    return await getVoteCounts(questions);
  }

  // Use a transaction for consistent counters
  await runTransaction(db, async (transaction) => {
    // Perform all reads first (scoped to question)
    const prevVoteRef = prevOptionId ? doc(db, 'votes', `vote_${questionId}_${prevOptionId}`) : null;
    const newVoteRef = doc(db, 'votes', `vote_${questionId}_${newOptionId}`);
    const userVoteSnapTx = await transaction.get(userVoteRef);
    const prevVoteSnap = prevVoteRef ? await transaction.get(prevVoteRef) : null;
    const newVoteSnap = await transaction.get(newVoteRef);

    // Then perform writes
    if (prevOptionId && prevOptionId !== newOptionId && prevVoteRef && prevVoteSnap && prevVoteSnap.exists()) {
      const prevCount = (prevVoteSnap.data() as any).count || 0;
      transaction.update(prevVoteRef, { count: Math.max(0, prevCount - 1) });
    }

    if (newVoteSnap.exists()) {
      const newCount = (newVoteSnap.data() as any).count || 0;
      transaction.update(newVoteRef, { count: newCount + 1 });
    } else {
      transaction.set(newVoteRef, { questionId, optionId: newOptionId, count: 1 });
    }

    transaction.set(userVoteRef, { userName, questionId, optionId: newOptionId }, { merge: true });
  });

  return await getVoteCounts(questions);
};