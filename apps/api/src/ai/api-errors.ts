import type { APICallError } from 'ai';

const INVALID_KEY =
  /API key not valid|API_KEY_INVALID|API key expired|Incorrect API key|invalid_api_key/i;

export function isInvalidKeyResponse(error: APICallError): boolean {
  return INVALID_KEY.test(`${error.message} ${error.responseBody ?? ''}`);
}
