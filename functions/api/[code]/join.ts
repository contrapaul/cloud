import { HttpError, doCall, readJson, readToken, validCode } from '../_lib';

/* Claim an anonymous seat. There is nothing to fill in: the token generated in
   the browser is the whole account, so joining twice from the same device
   reclaims the same seat and therefore the same votes. */
export const onRequestPost = async (context: any) => {
  const code = String(context.params.code || '').toUpperCase();
  if (!validCode(code)) throw new HttpError(404, 'No cloud with that code.');
  const body = await readJson(context.request);
  return doCall(context.env, code, 'join', readToken(context.request, body), {});
};
