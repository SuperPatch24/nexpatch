// Shared HTTP helpers: JSON responses, friendly errors, and the signed-in user wrapper.
import { verifyUser } from './auth.js';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export const json = (status, body) => ({ status, jsonBody: body });

// Wraps a handler so it only runs for a valid Nexpatch user and always returns JSON.
export function withUser(handler) {
  return async (request, context) => {
    try {
      const user = await verifyUser(request);
      const body = await handler(request, context, user);
      return json(200, body ?? {});
    } catch (err) {
      if (err instanceof HttpError) return json(err.status, { error: err.message });
      context.error('Unhandled error', err);
      return json(500, { error: 'Something went wrong on the server. Please try again.' });
    }
  };
}
