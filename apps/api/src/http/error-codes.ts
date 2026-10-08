export const ERROR_CODES = [
  'bad_request',
  'invalid_json',
  'payload_too_large',
  'validation_error',
  'unauthenticated',
  'invalid_credentials',
  'email_taken',
  'not_found',
  'rate_limited',
  'file_required',
  'file_too_large',
  'unsupported_file_type',
  'invalid_file',
  'invalid_upload',
  'document_limit',
  'chat_limit',
  'chat_full',
  'chat_unavailable',
  'internal_error',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];
