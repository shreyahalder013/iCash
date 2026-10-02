/**
 * iCash Frontend Configuration
 * Production uses the separately deployed liveness service.
 */
window.ICASH_CONFIG = {
  API_BASE_URL: '',
  // Dynamic liveness service endpoint (local microservice or deployed)
  LIVENESS_URL:
    typeof window !== 'undefined' &&
    (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
      ? 'http://127.0.0.1:5001'
      : 'https://icash-liveness.onrender.com',
};
