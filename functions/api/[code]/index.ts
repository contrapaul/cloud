import { HttpError, doCall, validCode } from '../_lib';

/* Meta for the join screen. Called before a socket is opened, so somebody who
   typed a code can see the title and confirm they are in the right place. */
export const onRequestGet = async (context: any) => {
  const code = String(context.params.code || '').toUpperCase();
  if (!validCode(code)) throw new HttpError(404, 'No cloud with that code.');
  return doCall(context.env, code, 'meta', '');
};
