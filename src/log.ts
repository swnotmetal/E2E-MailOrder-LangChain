// One JSON object per line, on stdout, so a run can be grepped and aggregated with jq.
//
// Free-text logs cannot answer "what happened to this message" without a human reading every line,
// and this project's evidence claims depend on exactly that answer. Field names are part of the
// contract: `event` says what happened, everything else is context, and anything token-shaped is
// redacted before it can reach a log file or a CI transcript.
export type LogFields = Record<string, unknown>;

const SECRET = /(token|secret|password|authorization|api[_-]?key)/i;

function scrub(fields: LogFields): LogFields {
  const safe: LogFields = {};
  for (const [key, value] of Object.entries(fields)) safe[key] = SECRET.test(key) ? '[redacted]' : value;
  return safe;
}

export type Log = (event: string, fields?: LogFields) => void;

export const log: Log = (event, fields = {}) => {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), level: 'info', event, ...scrub(fields) })}\n`);
};

export const logError: Log = (event, fields = {}) => {
  // stdout, not stderr: ordering with the surrounding events matters more than the stream.
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), level: 'error', event, ...scrub(fields) })}\n`);
};
