import { HttpError, roomStub, validCode } from '../_lib';

/* WebSocket upgrade. The token arrives as ?t= because browsers cannot set
   headers on a WebSocket handshake. This Function strips any client supplied
   identity header and re-injects the token itself, so the DO can trust it.
   Without the delete, anyone could claim to be the host. */
export const onRequestGet = async (context: any) => {
  const { request } = context;
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    throw new HttpError(426, 'Expected a WebSocket upgrade.');
  }
  const code = String(context.params.code || '').toUpperCase();
  if (!validCode(code)) throw new HttpError(404, 'No cloud with that code.');

  const token = new URL(request.url).searchParams.get('t') || '';
  const headers = new Headers(request.headers);
  headers.delete('X-Cloud-Token');
  if (token) headers.set('X-Cloud-Token', token);

  return roomStub(context.env, code).fetch(
    new Request(request.url, { method: 'GET', headers })
  );
};
