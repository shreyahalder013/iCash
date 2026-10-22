/* =========================================================
   ICASH — Structured Logger (Pino)
   ========================================================= */
const pino = require('pino');

const isProduction = process.env.NODE_ENV === 'production';
const logLevel = process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug');

const transport = isProduction
  ? undefined
  : {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
        singleLine: false
      }
    };

const logger = pino({
  level: logLevel,
  transport,
  base: {
    service: 'icash-bank',
    env: process.env.NODE_ENV || 'development'
  },
  redact: {
    paths: [
      '*.password',
      '*.pin',
      '*.pinHash',
      '*.normalPin',
      '*.emergencyPin',
      '*.sessionSecret',
      '*.jwtSecret',
      '*.apiKey',
      '*.biometricTemplate',
      '*.liveDescriptor',
      '*.sessionNonce',
      '*.challengeId',
      'req.headers.authorization',
      'req.headers.cookie',
      'req.cookies'
    ],
    censor: '[REDACTED]'
  },
  formatters: {
    level: (label) => ({ level: label })
  }
});

module.exports = logger;