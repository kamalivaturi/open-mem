// Strip secrets before anything is stored or sent to an observer model.
const RULES = [
  [/<private>[\s\S]*?<\/private>/gi, '[PRIVATE]'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]'],
  [/\bsk-(?:ant-|proj-|or-)?[A-Za-z0-9_-]{20,}/g, '[REDACTED_KEY]'],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/g, '[REDACTED_GITHUB_TOKEN]'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[REDACTED_AWS_KEY]'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, '[REDACTED_SLACK_TOKEN]'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, '[REDACTED_GOOGLE_KEY]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[REDACTED_JWT]'],
  [/(\bBearer\s+)[A-Za-z0-9._~+/-]{16,}=*/gi, '$1[REDACTED]'],
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, '$1[REDACTED]@'],
  [/((?:api[_-]?key|secret|token|passw(?:or)?d|pwd|client[_-]?secret)["']?\s*[:=]\s*["']?)[^\s"',;]{6,}/gi, '$1[REDACTED]'],
];

export const redact = s => (typeof s === 'string' ? RULES.reduce((t, [re, r]) => t.replace(re, r), s) : s);

// Keep head and tail of long tool output; the middle is rarely what matters.
export function clip(s, max) {
  if (typeof s !== 'string') s = JSON.stringify(s) ?? '';
  return s.length <= max ? s : `${s.slice(0, max * 0.7)}\n…[${s.length - max} chars cut]…\n${s.slice(-max * 0.3)}`;
}
