export const DEFAULT_API_BASE = 'https://168-107-32-199.sslip.io';

export function validateApiBase(value: string): string {
  const url = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('서버 주소는 HTTPS 출처 또는 로컬 개발용 HTTP 출처여야 합니다.');
  }
  return url.origin;
}

