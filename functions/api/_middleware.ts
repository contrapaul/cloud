import { HttpError, json } from './_lib';

/* One place to turn a thrown HttpError into a JSON response, so no handler
   below has to carry a try/catch. Anything unexpected becomes a 500 with a
   message the client can show, and the detail goes to the log. */
export const onRequest = async (context: any) => {
  try {
    return await context.next();
  } catch (err: any) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status);
    console.error('Unhandled', err?.stack || err);
    return json({ error: 'Something went wrong at our end.' }, 500);
  }
};
