'use strict';

class ScalvinError extends Error {
  constructor(message, code = 'SCALVIN_ERROR', details = undefined, exitCode = 1) {
    super(message);
    this.name = 'ScalvinError';
    this.code = code;
    this.details = details;
    this.exitCode = exitCode;
  }
}

function invariant(condition, message, code, details) {
  if (!condition) throw new ScalvinError(message, code, details);
}

module.exports = { ScalvinError, invariant };
