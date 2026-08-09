import { HttpError, doCall, json, newCode, readData, readJson, readToken } from './_lib';

// Kept in step with the placeholder on the new cloud page, so a request that
// arrives without a question produces what the creator was looking at.
const DEFAULT_QUESTION = 'What are your favorite types of cloud?';

/* Create a cloud. The creator's token becomes the host token, which is the
   only privileged thing in the system: it is never broadcast, and holding it
   is what lets somebody hide an entry, merge two entries or lock the cloud. */
export const onRequestPost = async (context: any) => {
  const { env, request } = context;
  const body = await readJson(request);
  const hostToken = readToken(request, body);

  const title = String(body.title || '').trim().slice(0, 80);
  if (!title) throw new HttpError(400, 'Give the cloud a title first.');

  const question = String(body.question || '').trim().slice(0, 140) || DEFAULT_QUESTION;

  const opts = {
    // 0 is unlimited, which is the default. Capping entries invites people to
    // agonise over their three best answers, and the first run wants volume.
    maxEntries: Math.max(0, Math.min(20, Number(body.maxEntries) || 0)),
    voting: body.voting !== false,
    maxChars: Math.max(10, Math.min(80, Number(body.maxChars) || 40)),
    filterOn: body.filterOn !== false,
  };

  const blocklistText = await readData(env, request, 'profanity.txt');

  const code = newCode();
  const res = await doCall(env, code, 'init', hostToken, {
    code,
    title,
    question,
    hostToken,
    opts,
    blocklistText,
  });
  if (!res.ok) return res;

  return json({ code });
};
