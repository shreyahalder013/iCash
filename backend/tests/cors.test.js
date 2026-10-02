const request = require('supertest');
const app = require('../src/server');

describe('CORS Configuration Tests', () => {
  test('allows requests from https://icash.onrender.com', async () => {
    const res = await request(app).get('/api/health').set('Origin', 'https://icash.onrender.com');

    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('https://icash.onrender.com');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  test('allows requests from https://icash-server.onrender.com', async () => {
    const res = await request(app)
      .get('/api/health')
      .set('Origin', 'https://icash-server.onrender.com');

    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('https://icash-server.onrender.com');
  });

  test('handles preflight OPTIONS requests from https://icash.onrender.com', async () => {
    const res = await request(app)
      .options('/api/health')
      .set('Origin', 'https://icash.onrender.com')
      .set('Access-Control-Request-Method', 'GET');

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('https://icash.onrender.com');
  });

  test('blocks unauthorized origins', async () => {
    const res = await request(app)
      .get('/api/health')
      .set('Origin', 'https://unauthorized-malicious-domain.com');

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Forbidden');
    expect(res.body.message).toMatch(/not allowed by CORS/i);
  });
});
