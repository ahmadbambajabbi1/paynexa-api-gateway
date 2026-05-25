import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import type { Request, Response, NextFunction } from 'express';
import { createProxyMiddleware, type Options } from 'http-proxy-middleware';

function headerValue(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

function gatewayPathRequiresAuth(path: string, method: string): boolean {
  const m = method.toUpperCase();
  if (m === 'OPTIONS') {
    return false;
  }
  if (path.startsWith('/users')) {
    if (m === 'GET' && (path === '/users' || path === '/users/')) {
      return false;
    }
    if (path.startsWith('/users/auth/phone/')) {
      return false;
    }
    return true;
  }
  if (path.startsWith('/transactions')) {
    if (m === 'GET' && (path === '/transactions' || path === '/transactions/')) {
      return false;
    }
    if (m === 'GET' && path.startsWith('/transactions/public/')) {
      return false;
    }
    return true;
  }
  if (path.startsWith('/escrow')) {
    return true;
  }
  if (path.startsWith('/messages')) {
    return true;
  }
  if (path.startsWith('/products')) {
    return true;
  }
  if (path.startsWith('/service-marketplace')) {
    // Public: categories, search, single listing detail (GET .../listings/:id only).
    if (m === 'GET') {
      if (
        path === '/service-marketplace/categories' ||
        path.startsWith('/service-marketplace/categories/')
      ) {
        return false;
      }
      if (
        path === '/service-marketplace/listings/search' ||
        path.startsWith('/service-marketplace/listings/search')
      ) {
        return false;
      }
      if (path === '/service-marketplace/listings/me') {
        return true;
      }
      const lid = /^\/service-marketplace\/listings\/([^/]+)$/.exec(path);
      if (lid?.[1] != null) {
        const seg = lid[1];
        if (seg !== 'search' && seg !== 'me' && seg !== 'complete') {
          return false;
        }
      }
    }
    return true;
  }
  return false;
}

function proxyOptions(
  target: string,
  extras?: Pick<Options, 'pathFilter' | 'pathRewrite'> & {
    /** Default 25s; product multipart + R2 needs longer. */
    proxyTimeoutMs?: number;
  },
): Options {
  const { proxyTimeoutMs, pathFilter, pathRewrite } = extras ?? {};
  return {
    target,
    changeOrigin: true,
    proxyTimeout: proxyTimeoutMs ?? 25_000,
    ...(pathFilter !== undefined ? { pathFilter } : {}),
    ...(pathRewrite !== undefined ? { pathRewrite } : {}),
    on: {
      proxyReq: (proxyReq, req) => {
        const incoming = req as Request & { body?: object };
        const ct = headerValue(req.headers['content-type'])?.toLowerCase() ?? '';
        if (ct.includes('multipart/form-data')) {
          return;
        }
        if (
          incoming.body &&
          typeof incoming.body === 'object' &&
          Object.keys(incoming.body).length > 0
        ) {
          const bodyData = JSON.stringify(incoming.body);
          proxyReq.setHeader('Content-Type', 'application/json');
          proxyReq.setHeader('Content-Length', Buffer.byteLength(bodyData));
          proxyReq.write(bodyData);
        }
      },
    },
  };
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const corsOrigin = process.env.CORS_ORIGIN?.trim();
  const origin =
    !corsOrigin || corsOrigin === '*'
      ? true
      : corsOrigin.split(',').map((s) => s.trim());
  app.enableCors({
    origin,
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Device-Id', 'Cache-Control', 'Pragma'],
  });
  const ipHits = new Map<string, { count: number; windowStart: number }>();

  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path === '/' || req.path.startsWith('/health')) {
      return next();
    }
    const now = Date.now();
    const key = req.ip ?? 'unknown';
    const current = ipHits.get(key);
    if (!current || now - current.windowStart > 60_000) {
      ipHits.set(key, { count: 1, windowStart: now });
    } else if (current.count >= 120) {
      return res.status(429).json({ message: 'Too many requests' });
    } else {
      current.count += 1;
    }
    const started = Date.now();
    res.on('finish', () => {
      const durationMs = Date.now() - started;
      console.log(
        JSON.stringify({
          service: 'api-gateway',
          method: req.method,
          path: req.path,
          status: res.statusCode,
          durationMs,
        }),
      );
    });
    return next();
  });

  const userUrl = process.env.USER_SERVICE_URL ?? 'http://127.0.0.1:5001';
  const transactionUrl =
    process.env.TRANSACTION_SERVICE_URL ?? 'http://127.0.0.1:5002';
  const escrowUrl = process.env.ESCROW_SERVICE_URL ?? 'http://127.0.0.1:5003';
  const messagingUrl =
    process.env.MESSAGING_SERVICE_URL ?? 'http://127.0.0.1:5004';
  const productUrl =
    process.env.PRODUCT_SERVICE_URL ?? 'http://127.0.0.1:5005';

  const server = app.getHttpAdapter().getInstance();

  // Socket.IO (booking comments, etc.) is served by product-service on `/socket.io`.
  server.use(
    createProxyMiddleware({
      target: productUrl,
      changeOrigin: true,
      ws: true,
      proxyTimeout: 86_400_000,
      pathFilter: (pathname: string) => pathname.startsWith('/socket.io'),
    }),
  );

  const authEnabled = process.env.GATEWAY_AUTH_ENABLED !== 'false';
  if (authEnabled) {
    server.use(async (req: Request, res: Response, next: NextFunction) => {
      if (req.path === '/' || req.path.startsWith('/health')) {
        return next();
      }
      if (!gatewayPathRequiresAuth(req.path, req.method)) {
        return next();
      }
      const authorization = headerValue(req.headers.authorization);
      const deviceId = headerValue(req.headers['x-device-id']);
      if (!authorization?.startsWith('Bearer ') || !deviceId) {
        return res.status(401).json({
          message: 'Missing Authorization bearer token or X-Device-Id',
        });
      }
      const meUrl = new URL('/users/me', userUrl.endsWith('/') ? userUrl : `${userUrl}/`);
      try {
        const r = await fetch(meUrl, {
          cache: 'no-store',
          headers: {
            authorization,
            'x-device-id': deviceId,
            'cache-control': 'no-cache',
            pragma: 'no-cache',
          },
        });
        if (!r.ok) {
          return res.status(401).json({ message: 'Invalid or expired session' });
        }
      } catch {
        return res.status(503).json({ message: 'User service unreachable' });
      }
      return next();
    });
  }

  // Proxy `/users/**` without mounting at `/users`: Express would strip the prefix and the
  // user-service would see `/auth/phone/...` instead of `/users/auth/phone/...` (404).
  server.use(
    createProxyMiddleware(
      proxyOptions(userUrl, {
        pathFilter: (pathname) =>
          pathname === '/users' || pathname.startsWith('/users/'),
      }),
    ),
  );
  // Long-lived SSE must not use the default 25s proxy socket timeout.
  server.use(
    createProxyMiddleware(
      proxyOptions(transactionUrl, {
        pathFilter: (pathname) =>
          pathname === '/transactions/notifications/stream',
        proxyTimeoutMs: 86_400_000,
      }),
    ),
  );
  server.use(
    createProxyMiddleware(
      proxyOptions(transactionUrl, {
        pathFilter: (pathname) =>
          pathname === '/transactions' || pathname.startsWith('/transactions/'),
      }),
    ),
  );
  server.use(
    createProxyMiddleware(
      proxyOptions(escrowUrl, {
        pathFilter: (pathname) =>
          pathname === '/escrow' || pathname.startsWith('/escrow/'),
      }),
    ),
  );
  server.use(
    createProxyMiddleware(
      proxyOptions(messagingUrl, {
        pathFilter: (pathname) =>
          pathname === '/messages' || pathname.startsWith('/messages/'),
      }),
    ),
  );
  server.use(
    createProxyMiddleware(
      proxyOptions(productUrl, {
        pathFilter: (pathname) =>
          pathname === '/products' || pathname.startsWith('/products/'),
        proxyTimeoutMs: 120_000,
      }),
    ),
  );

  // Service marketplace module lives in product-service.
  server.use(
    createProxyMiddleware(
      proxyOptions(productUrl, {
        pathFilter: (pathname) =>
          pathname === '/service-marketplace' ||
          pathname.startsWith('/service-marketplace/'),
      }),
    ),
  );

  await app.listen(process.env.PORT ?? 5000);
}
bootstrap();
