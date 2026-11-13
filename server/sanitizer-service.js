/**
 * Devlups Lab — Enterprise Log & Output Sanitization Engine
 * Automatically scrubs secrets, tokens, credentials, and connection strings
 */

const SENSITIVE_PATTERNS = [
  // GitHub Tokens
  { regex: /ghp_[A-Za-z0-9_]{36,}/g, replacement: 'ghp_********************************' },
  { regex: /github_pat_[A-Za-z0-9_]{82,}/g, replacement: 'github_pat_********************************' },
  { regex: /oauth2:[^@]+@github\.com/g, replacement: 'oauth2:***@github.com' },

  // AWS Credentials
  { regex: /AKIA[0-9A-Z]{16}/g, replacement: 'AKIA****************' },
  { regex: /(aws_secret_access_key\s*[:=]\s*)[^\s]+/gi, replacement: '$1****************************************' },

  // Azure Secrets & Tokens
  { regex: /(client_secret\s*[:=]\s*)[^\s]+/gi, replacement: '$1********************************' },
  { regex: /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi, replacement: '********-****-****-****-************' },

  // DigitalOcean Tokens
  { regex: /dop_v1_[a-f0-9]{64}/gi, replacement: 'dop_v1_****************************************************************' },

  // Private Keys (RSA, EC, OpenSSH)
  { regex: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z]+ )?PRIVATE KEY-----/g, replacement: '-----BEGIN PRIVATE KEY-----\n[REDACTED ENTERPRISE PRIVATE KEY]\n-----END PRIVATE KEY-----' },

  // Connection Strings with Passwords
  { regex: /((?:postgres|postgresql|mysql|mongodb|redis):\/\/[^:\s]+:)[^@\s]+(@[^\s]+)/gi, replacement: '$1*****$2' },

  // Bearer & Authorization Tokens
  { regex: /(Bearer\s+)[A-Za-z0-9\-._~+/]+=*/gi, replacement: '$1************************' },

  // Generic API Keys & Passwords in query/env
  { regex: /(password\s*[:=]\s*)[^\s&]+/gi, replacement: '$1*****' },
  { regex: /(secret\s*[:=]\s*)[^\s&]+/gi, replacement: '$1*****' },
  { regex: /(api[_-]?key\s*[:=]\s*)[^\s&]+/gi, replacement: '$1*****' },
  { regex: /(token\s*[:=]\s*)[^\s&]+/gi, replacement: '$1*****' },
];

export const sanitizerService = {
  /**
   * Sanitize log text by masking all detected secrets
   */
  sanitize(text) {
    if (!text || typeof text !== 'string') return text;
    let result = text;
    for (const pattern of SENSITIVE_PATTERNS) {
      result = result.replace(pattern.regex, pattern.replacement);
    }
    return result;
  }
};

