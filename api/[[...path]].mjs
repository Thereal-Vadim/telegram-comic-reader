export const config = { maxDuration: 60 };
export default function handler(_req, res) {
  res.statusCode = 503;
  res.setHeader('content-type', 'text/plain; charset=utf-8');
  res.end('API bundle missing — rebuild with bundle-api');
}
